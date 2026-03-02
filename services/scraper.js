const axios = require('axios');
const cheerio = require('cheerio');
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');

// ✅ IMPORT GOOGLE INDEXER (Pastikan file googleIndexer.js sudah dibuat di folder yang sama)
const { requestGoogleIndex } = require('./googleIndexer');

// --- KONFIGURASI AXIOS ---
const AXIOS_OPTIONS = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Referer': 'https://google.com'
  },
  timeout: 10000 // Timeout 10 detik
};

/**
 * HELPER: Ekstrak Slug dari URL
 */
function getSlugFromUrl(url) {
  if (!url) return null;
  const cleanUrl = url.replace(/\/$/, ''); // Hapus slash di akhir
  const parts = cleanUrl.split('/');
  return parts[parts.length - 1]; // Ambil bagian terakhir
}

/**
 * FUNGSI 1: SCRAPE DETAIL KOMIK (Komiku.org)
 */
async function scrapeManga(url) {
  try {
    console.log(`🔍 [Scraper] Mengunjungi Manga: ${url}`);
    const { data } = await axios.get(url, AXIOS_OPTIONS);
    const $ = cheerio.load(data);

    // 1. Ambil Slug dari URL
    const mangaSlug = getSlugFromUrl(url);
    if (!mangaSlug) throw new Error("Gagal mengambil slug dari URL");

    // 2. Metadata Dasar
    let title = $('#Judul header h1 span').text().trim();
    title = title.replace(/^Komik\s+/i, '').trim(); 
    
    const nativeTitle = $('.j2').text().trim();
    let coverImage = $('.ims img').attr('src');

    // 3. Mengambil Informasi dari Tabel (.inftable)
    let type = 'Manga';
    let status = 'Unknown';
    let author = 'Unknown';
    
    $('.inftable tr').each((i, el) => {
      const label = $(el).find('td').eq(0).text().trim().toLowerCase();
      const value = $(el).find('td').eq(1).text().trim();
      
      if (label.includes('jenis komik')) type = value;
      if (label.includes('pengarang')) author = value;
      if (label.includes('status')) status = value;
    });

    const synopsis = $('section#Informasi p.desc').text().trim() || 'Sinopsis belum tersedia.';
    
    const genres = [];
    $('ul.genre li.genre a span').each((i, el) => genres.push($(el).text().trim()));

    const rating = 0; 

    // 4. Scrape Daftar Chapter
    const chapters = [];
    
    $('#Daftar_Chapter tbody tr').each((i, el) => {
      if ($(el).find('th').length > 0) return;

      const linkTag = $(el).find('.judulseries a');
      const time = $(el).find('.tanggalseries').text().trim();
      
      if (linkTag.length > 0) {
        let chapterUrl = linkTag.attr('href');
        
        if (chapterUrl && !chapterUrl.startsWith('http')) {
             chapterUrl = 'https://komiku.org' + chapterUrl;
        }
        
        const chapterTitle = linkTag.text().replace(/\s+/g, ' ').trim();
        const chapterSlug = getSlugFromUrl(chapterUrl);

        if (chapterUrl && chapterSlug) {
          chapters.push({
            title: chapterTitle,
            url: chapterUrl,
            slug: chapterSlug,
            releaseDate: time
          });
        }
      }
    });

    console.log(`📑 [Scraper] Ditemukan ${chapters.length} chapter untuk komik ini.`);

    // --- LOGIKA MENCEGAH DUPLICATE KEY ERROR & SMART UPDATE ---
    let existingManga = await Manga.findOne({ sourceUrl: url }) || await Manga.findOne({ slug: mangaSlug });
    let lastUpdatedTime = new Date(); 
    
    // ✅ Cek apakah ini Manga baru atau Manga Lama yang mendapat Update
    const isNewManga = !existingManga;
    let isUpdated = false;

    if (existingManga && existingManga.chapters && existingManga.chapters.length > 0 && chapters.length > 0) {
        const latestScrapedUrl = chapters[0].url;
        const latestDbUrl = existingManga.chapters[0].url;

        if (latestScrapedUrl === latestDbUrl) {
            console.log(`⏸️ [Scraper] Tidak ada chapter baru: ${title}`);
            lastUpdatedTime = existingManga.lastUpdated; 
        } else {
            console.log(`🔥 [Scraper] Chapter baru: ${title}! Naik ke atas.`);
            isUpdated = true; // Tandai bahwa ada update chapter
        }
    } else if (existingManga && chapters.length > 0) {
        // Kasus dimana manga sudah ada tapi sebelumnya belum punya chapter
        isUpdated = true;
    }

    // 5. Simpan ke Database
    const query = existingManga ? { _id: existingManga._id } : { slug: mangaSlug };
    const mangaData = await Manga.findOneAndUpdate(
      query,
      {
        sourceUrl: url,
        slug: mangaSlug, 
        title,
        nativeTitle,
        coverImage,
        type,
        rating, 
        author,
        status,
        synopsis,
        genres,
        chapters,
        lastUpdated: lastUpdatedTime
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // ========================================================
    // 🚀 INTEGRASI GOOGLE INDEXING API
    // ========================================================
    if (isNewManga || isUpdated) {
        const frontendUrl = `https://kiryuu.online/manga/${mangaSlug}`;
        
        if (isNewManga) {
            console.log(`🚀 [SEO] Manga Baru! Meminta Google untuk mengindeks: ${frontendUrl}`);
        } else if (isUpdated) {
            console.log(`🚀 [SEO] Manga Update! Meminta Google merayapi ulang: ${frontendUrl}`);
        }
        
        // Memanggil fungsi tanpa await agar proses scraper tidak melambat
        // Note: Pastikan kamu tidak melebihi kuota 200 URL / hari dari Google
        if (typeof requestGoogleIndex === 'function') {
            requestGoogleIndex(frontendUrl);
        } else {
            console.error('⚠️ [SEO Warning] Fungsi requestGoogleIndex tidak ditemukan!');
        }
    }

    // ========================================================
    // 6. AUTO SCRAPE KONTEN CHAPTER (ANTI CLOUDFLARE BLOCK)
    // ========================================================
    console.log(`⚙️ [Auto-Scrape] Memeriksa konten chapter yang belum di-scrape...`);
    
    // Kita jalankan loop dari chapter paling awal (index terakhir) ke terbaru (index 0)
    // Supaya user bisa baca dari awal meski scrape belum selesai semua
    for (let i = chapters.length - 1; i >= 0; i--) {
        const chap = chapters[i];
        
        try {
            // Cek apakah chapter ini sudah pernah di-scrape gambarnya
            const existingChapterData = await Chapter.findOne({ mangaSlug, chapterSlug: chap.slug });
            
            // Jika belum ada, atau jika array gambar kosong, maka kita Scrape!
            if (!existingChapterData || !existingChapterData.images || existingChapterData.images.length === 0) {
                console.log(`⏳ Mengambil gambar untuk: ${chap.title}...`);
                await scrapeChapterContent(chap.url, mangaSlug, chap.slug);
                
                // JEDA WAKTU (DELAY) SANGAT PENTING UNTUK VERCEL & CLOUDFLARE
                // Beri waktu napas 3 detik antar chapter
                await new Promise(resolve => setTimeout(resolve, 3000)); 
            }
        } catch (chapterErr) {
            console.error(`❌ Gagal auto-scrape ${chap.title}:`, chapterErr.message);
            // Tetap lanjut ke chapter berikutnya meski ada 1 chapter gagal
            continue; 
        }
    }

    console.log(`✅ [Scraper] Semua chapter untuk ${title} berhasil diperiksa/disimpan!`);
    return mangaData;

  } catch (error) {
    if (error.code === 11000) {
        console.error(`⚠️ [Scraper Warning] Duplicate Key untuk ${url}. Melewati...`);
    } else {
        console.error(`❌ [Scraper Error] Gagal scrape Manga (${url}):`, error.message);
    }
    return null;
  }
}

/**
 * FUNGSI 2: SCRAPE KONTEN CHAPTER (Komiku.org)
 */
async function scrapeChapterContent(url, mangaSlug, chapterSlug) {
  try {
    const { data } = await axios.get(url, AXIOS_OPTIONS);
    const $ = cheerio.load(data);

    // Ambil Judul
    const title = $('#Judul header h1').text().trim() || 'Chapter Unknown';

    // Ambil Gambar (Dari dalam div #Baca_Komik dengan class .ww)
    const images = [];
    $('#Baca_Komik img.ww').each((i, el) => {
      let src = $(el).attr('src') || $(el).attr('data-src');

      if (src && src.trim() !== '') {
        src = src.trim();
        if (src.startsWith('//')) src = 'https:' + src;
        images.push(src);
      }
    });

    // Navigasi Next/Prev
    let nextSlug = null;
    let prevSlug = null;
    
    const nextLink = $('.toolbar a[aria-label="Next"]').attr('href');
    if (nextLink) nextSlug = getSlugFromUrl(nextLink);

    const prevLink = $('.toolbar a[aria-label="Prev"]').attr('href') || $('.toolbar a[aria-label="Previous"]').attr('href');
    if (prevLink) prevSlug = getSlugFromUrl(prevLink);

    if (images.length === 0) {
      throw new Error("Tidak ada gambar ditemukan di struktur #Baca_Komik img.ww");
    }

    // Simpan Chapter
    const chapterData = await Chapter.findOneAndUpdate(
      { mangaSlug, chapterSlug },
      { 
        title, 
        images, 
        nextSlug, 
        prevSlug,
        lastScraped: new Date() 
      },
      { upsert: true, new: true }
    );

    console.log(`✅ Tersimpan: ${images.length} gambar.`);
    return chapterData;

  } catch (error) {
    throw error; // Lempar error agar ditangkap oleh blok Auto-Scrape
  }
}

module.exports = { scrapeManga, scrapeChapterContent };