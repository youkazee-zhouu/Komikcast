/**
 * scraperQueue.js
 * ───────────────
 * Sistem antrian scraping ringan (in-memory).
 * Simpan di: /services/scraperQueue.js
 */

const { scrapeManga, scrapeChapterContent } = require('./scraper');
const Manga   = require('../models/Manga');
const Chapter = require('../models/Chapter');

// ── KONFIGURASI ────────────────────────────────────────────────
const STALE_HOURS    = 6;   // Manga dianggap usang jika > 6 jam
const MAX_CONCURRENT = 1;   // 1 job berjalan sekaligus (cegah ban IP)
const MAX_QUEUE      = 50;  // Tolak jika antrian penuh
// ───────────────────────────────────────────────────────────────

const queue = [];         // ID job yang menunggu
const jobs  = new Map();  // Semua job (id → job object)
let activeJobs = 0;

// ── HELPERS ─────────────────────────────────────────────────────
function makeId() {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
}

function serializeJob(job) {
    return {
        id:          job.id,
        type:        job.type,
        status:      job.status,
        error:       job.error  || null,
        createdAt:   job.createdAt,
        startedAt:   job.startedAt   || null,
        finishedAt:  job.finishedAt  || null,
    };
}

// ── PROSES ANTRIAN ───────────────────────────────────────────────
async function processNext() {
    if (activeJobs >= MAX_CONCURRENT || queue.length === 0) return;

    const jobId = queue.shift();
    const job   = jobs.get(jobId);
    if (!job) return;

    activeJobs++;
    job.status    = 'running';
    job.startedAt = new Date();

    try {
        if (job.type === 'manga') {
            // Ambil sourceUrl dari DB → scrape ulang
            const manga = await Manga.findOne({ slug: job.payload.slug })
                .select('sourceUrl').lean();
            if (!manga?.sourceUrl) throw new Error('sourceUrl tidak ditemukan di DB');
            await scrapeManga(manga.sourceUrl);

        } else if (job.type === 'chapter') {
            // Ambil URL chapter dari array Manga.chapters
            const manga = await Manga.findOne({ slug: job.payload.mangaSlug })
                .select('chapters').lean();
            const chap  = manga?.chapters?.find(c => c.slug === job.payload.chapterSlug);
            if (!chap?.url) throw new Error('URL chapter tidak ditemukan di DB');
            await scrapeChapterContent(chap.url, job.payload.mangaSlug, job.payload.chapterSlug);
        }

        job.status = 'done';
        console.log(`✅ [Queue] Job selesai: ${jobId}`);

    } catch (err) {
        job.status = 'failed';
        job.error  = err.message;
        console.error(`❌ [Queue] Job gagal: ${jobId} →`, err.message);

    } finally {
        job.finishedAt = new Date();
        activeJobs--;
        // Hapus job dari memory setelah 10 menit
        setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
        processNext();
    }
}

// ── ENQUEUE ──────────────────────────────────────────────────────
/**
 * Masukkan job ke antrian.
 * Jika sudah ada job pending/running untuk slug yang sama → return job lama.
 */
function enqueue(type, payload) {
    // Anti-duplikat: cari job pending/running dengan slug sama
    const slugKey = payload.chapterSlug || payload.slug;
    for (const job of jobs.values()) {
        const existingKey = job.payload.chapterSlug || job.payload.slug;
        if (existingKey === slugKey && (job.status === 'pending' || job.status === 'running')) {
            return job;
        }
    }

    if (queue.length >= MAX_QUEUE) {
        throw new Error('Antrian scrape penuh, coba lagi nanti.');
    }

    const id  = makeId();
    const job = {
        id, type, payload,
        status:     'pending',
        error:      null,
        createdAt:  new Date(),
        startedAt:  null,
        finishedAt: null,
    };

    jobs.set(id, job);
    queue.push(id);
    console.log(`📋 [Queue] Job baru: ${id} | ${type} | ${slugKey}`);

    processNext();
    return job;
}

// ── STALE CHECK ──────────────────────────────────────────────────
/**
 * Cek apakah manga perlu di-scrape ulang.
 */
async function checkIfStale(slug) {
    const manga = await Manga.findOne({ slug })
        .select('lastUpdated sourceUrl').lean();

    if (!manga)            return { needsScrape: true, reason: 'not_found' };
    if (!manga.sourceUrl)  return { needsScrape: false, reason: 'no_source_url' };
    if (!manga.lastUpdated) return { needsScrape: true,  reason: 'no_update_time' };

    const hours = (Date.now() - new Date(manga.lastUpdated).getTime()) / 3_600_000;
    if (hours > STALE_HOURS) {
        return { needsScrape: true, reason: 'stale', hoursSinceUpdate: Math.round(hours) };
    }

    return { needsScrape: false, reason: 'fresh' };
}

// ── PUBLIC API ───────────────────────────────────────────────────
function getJobStatus(jobId) {
    const job = jobs.get(jobId);
    return job ? serializeJob(job) : null;
}

function getQueueStats() {
    const all = [...jobs.values()];
    return {
        queueLength:  queue.length,
        activeJobs,
        totalTracked: jobs.size,
        pending:  all.filter(j => j.status === 'pending').length,
        running:  all.filter(j => j.status === 'running').length,
        done:     all.filter(j => j.status === 'done').length,
        failed:   all.filter(j => j.status === 'failed').length,
    };
}

module.exports = { enqueue, getJobStatus, getQueueStats, checkIfStale };
