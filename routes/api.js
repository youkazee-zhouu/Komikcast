const express = require('express');
const router = express.Router();
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');
const User = require('../models/User');
const mongoose = require('mongoose');

// ==========================================
// HELPER FUNCTIONS
// ==========================================

const successResponse = (res, data, pagination = null) => {
    res.json({ success: true, data, pagination });
};

const settingsSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: String
});
const Settings = mongoose.model('Settings', settingsSchema);

const errorResponse = (res, message, code = 500) => {
    console.error(`[API Error] ${message}`);
    res.status(code).json({ success: false, message });
};

// ==========================================
// SIMPLE IN-MEMORY RESPONSE CACHE
// ==========================================
const responseCache = new Map();

const getCachedResponse = (key) => {
    const cached = responseCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        responseCache.delete(key);
        return null;
    }
    return cached.payload;
};

const setCachedResponse = (key, payload, ttlSeconds) => {
    responseCache.set(key, {
        payload,
        expiresAt: Date.now() + (ttlSeconds * 1000)
    });
};

const invalidateCacheByPrefix = (prefix) => {
    for (const key of responseCache.keys()) {
        if (key.startsWith(prefix)) {
            responseCache.delete(key);
        }
    }
};

const cacheMiddleware = (ttlSeconds = 60) => (req, res, next) => {
    const key = req.originalUrl;
    const cachedPayload = getCachedResponse(key);
    if (cachedPayload) {
        return res.json(cachedPayload);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            setCachedResponse(key, body, ttlSeconds);
        }
        return originalJson(body);
    };
    next();
};

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of responseCache.entries()) {
        if (value.expiresAt <= now) {
            responseCache.delete(key);
        }
    }
}, 60 * 1000).unref();

const getPaginationParams = (req, defaultLimit = 24) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || defaultLimit);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

// ==========================================
// ✅ OPTIMASI 1: FORMAT MANGA LIST
// Hanya pakai data dari chapters[0] (sudah di-slice di query)
// TIDAK lagi memuat seluruh array chapters ratusan/ribuan item
// ==========================================
const formatMangaList = (mangas) => {
    return mangas.map(m => {
        const latestChap = m.chapters && m.chapters.length > 0 ? m.chapters[0] : null;
        return {
            _id: m._id,
            title: m.title,
            slug: m.slug,
            coverImage: m.coverImage,
            type: m.type,
            status: m.status,
            rating: m.rating,
            views: m.views || 0,
            lastUpdated: m.lastUpdated,
            chapter_count: m.chapter_count || 0, // dari field terpisah (lihat query)
            last_chapter: latestChap ? latestChap.title : '?',
            last_chapter_slug: latestChap ? latestChap.slug : ''
        };
    });
};

// ==========================================
// ✅ OPTIMASI 2: PROJECTION HELPER
// $slice: 1  → hanya ambil chapter pertama dari array
// chapter_count → hitung total chapters tanpa load semua data
// Ini MENCEGAH ribuan baris chapters masuk ke RAM & response
// ==========================================
const MANGA_LIST_PROJECTION = {
    title: 1,
    slug: 1,
    coverImage: 1,
    type: 1,
    status: 1,
    rating: 1,
    views: 1,
    lastUpdated: 1,
    chapters: { $slice: 1 },          // ← KUNCI: hanya ambil 1 chapter pertama
    chapter_count: { $size: '$chapters' } // ← total count tanpa load semua
};
// Catatan: $size di projection tidak bekerja di find() biasa.
// Gunakan aggregate() atau hitung chapter_count via addFields.
// Cara paling mudah & efisien: gunakan aggregate di bawah.

// Helper query dengan aggregate untuk list manga
const findMangaList = async (matchQuery, sortOption, skip, limit) => {
    return Manga.aggregate([
        { $match: matchQuery },
        { $sort: sortOption },
        { $skip: skip },
        { $limit: limit },
        {
            $project: {
                title: 1,
                slug: 1,
                coverImage: 1,
                type: 1,
                status: 1,
                rating: 1,
                views: 1,
                lastUpdated: 1,
                chapter_count: { $size: { $ifNull: ['$chapters', []] } }, // total chapter
                chapters: { $slice: ['$chapters', 1] }                     // hanya chapter pertama
            }
        }
    ]);
};

// ==========================================
// 1. UTAMA: ADVANCED FILTER & SEARCH
// ==========================================
router.get('/manga-list', cacheMiddleware(60), async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);
        const { q, status, type, genre, order } = req.query;

        let matchQuery = {};
        if (q) matchQuery.title = { $regex: q, $options: 'i' };
        if (status && status !== 'all') matchQuery.status = { $regex: new RegExp(`^${status}$`, 'i') };
        if (type && type !== 'all') matchQuery.type = { $regex: new RegExp(`^${type}$`, 'i') };
        if (genre && genre !== 'all') {
            const cleanGenre = genre.replace(/-/g, '[\\s\\-]');
            matchQuery.genres = { $regex: new RegExp(cleanGenre, 'i') };
        }

        let sortOption = { lastUpdated: -1 };
        switch (order) {
            case 'oldest': sortOption = { lastUpdated: 1 }; break;
            case 'popular': sortOption = { views: -1 }; break;
            case 'az': sortOption = { title: 1 }; break;
            case 'za': sortOption = { title: -1 }; break;
        }

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(matchQuery),
            findMangaList(matchQuery, sortOption, skip, limit)
        ]);

        successResponse(res, formatMangaList(mangasRaw), {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            perPage: limit
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 2. HOME PAGE DATA
// ==========================================
router.get('/home', cacheMiddleware(45), async (req, res) => {
    try {
        // ✅ Semua query pakai aggregate → hanya ambil 1 chapter pertama
        const [trendingRaw, manhwasRaw, mangasRaw, manhuasRaw] = await Promise.all([
            findMangaList({}, { views: -1 }, 0, 10),
            findMangaList({ type: { $regex: 'manhwa', $options: 'i' } }, { lastUpdated: -1 }, 0, 12),
            findMangaList({ type: { $regex: 'manga', $options: 'i' } }, { lastUpdated: -1 }, 0, 12),
            findMangaList({ type: { $regex: 'manhua', $options: 'i' } }, { lastUpdated: -1 }, 0, 12),
        ]);

        successResponse(res, {
            trending: formatMangaList(trendingRaw),
            manhwas: formatMangaList(manhwasRaw),
            manhuas: formatMangaList(manhuasRaw),
            mangas: formatMangaList(mangasRaw)
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 3. DETAIL & READ ENDPOINTS
// ==========================================

// GET /api/manga/:slug
router.get('/manga/:slug', async (req, res) => {
    try {
        // ✅ OPTIMASI 3: DETAIL MANGA
        // Chapters dikirim hanya dengan field { title, slug } — tanpa 'url'
        // 'url' hanya dibutuhkan worker scraper, bukan frontend
        const manga = await Manga.findOneAndUpdate(
            { slug: req.params.slug },
            { $inc: { views: 1 } },
            {
                new: true,
                // Projection: ambil semua field KECUALI chapters.url
                projection: {
                    title: 1, slug: 1, coverImage: 1, type: 1, status: 1,
                    rating: 1, views: 1, lastUpdated: 1, synopsis: 1,
                    genres: 1, author: 1, artist: 1,
                    'chapters.title': 1, // ← hanya title & slug per chapter
                    'chapters.slug': 1   // ← TIDAK ada chapters.url
                }
            }
        ).lean();

        if (!manga) return errorResponse(res, 'Manga not found', 404);

        // Rekomendasi (Genre Sejenis) — pakai aggregate juga
        let recommendationsRaw = [];
        if (manga.genres && manga.genres.length > 0) {
            recommendationsRaw = await findMangaList(
                { genres: { $in: manga.genres }, _id: { $ne: manga._id } },
                { views: -1 },
                0,
                4
            );
        }

        successResponse(res, {
            info: manga,
            recommendations: formatMangaList(recommendationsRaw)
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/read/:slug/:chapterSlug
router.get('/read/:slug/:chapterSlug', cacheMiddleware(300), async (req, res) => {
    try {
        const { slug, chapterSlug } = req.params;

        const [manga, chapter] = await Promise.all([
            Manga.findOne({ slug })
                .select('title slug coverImage')
                .lean(),
            Chapter.findOne({ mangaSlug: slug, chapterSlug })
                .select('title images prevSlug nextSlug createdAt') // ← select eksplisit
                .lean()
        ]);

        if (!manga) return errorResponse(res, 'Manga not found', 404);
        if (!chapter) return errorResponse(res, 'Chapter not found', 404);

        successResponse(res, {
            chapter: {
                title: chapter.title,
                images: chapter.images,
                createdAt: chapter.createdAt
            },
            manga,
            navigation: {
                prev: chapter.prevSlug || null,
                next: chapter.nextSlug || null
            }
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 4. GENRES LIST
// ==========================================
router.get('/genres', cacheMiddleware(1800), async (req, res) => {
    try {
        const genres = await Manga.aggregate([
            { $unwind: '$genres' },
            { $match: { genres: { $ne: '' } } },
            { $group: { _id: '$genres', count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);

        const formattedGenres = genres.map(g => ({ name: g._id, count: g.count }));
        successResponse(res, formattedGenres);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 5. USER SYNC
// ==========================================

// ✅ OPTIMASI 4: USER SYNC — hanya kembalikan field esensial
// TIDAK lagi mengirim library/history/notifications (bisa ratusan item) ke frontend saat login
const USER_ESSENTIAL_FIELDS = 'googleId email displayName photoURL isAdmin isPremium premiumUntil bio dailyDownloads';

router.post('/users/sync', async (req, res) => {
    try {
        const { googleId, email, displayName, photoURL } = req.body;
        if (!googleId) return errorResponse(res, 'googleId is required', 400);

        const ADMIN_UIDS = ['BUkIZguy10hnIG8jAooZoycG7ak1'];
        const isUserAdmin = ADMIN_UIDS.includes(googleId);

        let user = await User.findOne({ googleId });
        const today = new Date().toISOString().split('T')[0];

        if (!user) {
            user = new User({
                googleId, email, displayName,
                photoURL: photoURL || '',
                isAdmin: isUserAdmin,
                isPremium: isUserAdmin,
                dailyDownloads: { date: today, count: 0 }
            });
        } else {
            user.isAdmin = isUserAdmin;
            if (displayName) user.displayName = displayName;
            if (photoURL) user.photoURL = photoURL;

            if (isUserAdmin) {
                user.isPremium = true;
            } else if (user.isPremium && user.premiumUntil) {
                if (new Date() > user.premiumUntil) {
                    user.isPremium = false;
                    user.premiumUntil = null;
                }
            }

            if (!user.dailyDownloads) {
                user.dailyDownloads = { date: today, count: 0 };
            } else if (user.dailyDownloads.date !== today) {
                user.dailyDownloads.date = today;
                user.dailyDownloads.count = 0;
            }
        }

        await user.save();

        // ✅ Hanya kirim field yang dibutuhkan frontend, bukan seluruh dokumen
        successResponse(res, {
            googleId: user.googleId,
            email: user.email,
            displayName: user.displayName,
            photoURL: user.photoURL,
            isAdmin: user.isAdmin,
            isPremium: user.isPremium,
            premiumUntil: user.premiumUntil,
            bio: user.bio,
            dailyDownloads: user.dailyDownloads,
            downloadCount: user.downloadCount
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 4. USER READ ENDPOINTS
// ==========================================

// GET /api/users/:googleId — ✅ Tanpa library/history/notifications
router.get('/users/:googleId', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId })
            .select(USER_ESSENTIAL_FIELDS + ' downloadCount')
            .lean();
        if (!user) return errorResponse(res, 'User not found', 404);
        successResponse(res, user);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/users/:googleId/library — ✅ Dengan pagination
router.get('/users/:googleId/library', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { page, limit, skip } = getPaginationParams(req, 20);

        const user = await User.findOne({ googleId }).select('library').lean();
        if (!user) return errorResponse(res, 'User not found', 404);

        const allLibrary = (user.library || []).sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
        const paginated = allLibrary.slice(skip, skip + limit);

        successResponse(res, paginated, {
            currentPage: page,
            totalPages: Math.ceil(allLibrary.length / limit),
            totalItems: allLibrary.length,
            perPage: limit
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/users/:googleId/history — ✅ Dengan pagination
router.get('/users/:googleId/history', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { page, limit, skip } = getPaginationParams(req, 20);

        const user = await User.findOne({ googleId }).select('history').lean();
        if (!user) return errorResponse(res, 'User not found', 404);

        const allHistory = (user.history || []).sort((a, b) => new Date(b.lastRead) - new Date(a.lastRead));
        const paginated = allHistory.slice(skip, skip + limit);

        successResponse(res, paginated, {
            currentPage: page,
            totalPages: Math.ceil(allHistory.length / limit),
            totalItems: allHistory.length,
            perPage: limit
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/users/:googleId/public-profile
router.get('/users/:googleId/public-profile', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId })
            .select('googleId displayName photoURL bio library isPremium isAdmin')
            .lean();

        if (!user) return errorResponse(res, 'User not found', 404);

        const library = user.library || [];
        const stats = library.reduce((acc, item) => {
            const status = item.mangaData?.readingStatus || 'reading';
            acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, {});

        successResponse(res, {
            googleId: user.googleId,
            displayName: user.displayName || '',
            photoURL: user.photoURL || '',
            bio: user.bio || '',
            isPremium: user.isPremium || false,
            isAdmin: user.isAdmin || false,
            library,
            stats: {
                reading: stats.reading || 0,
                to_read: stats.to_read || 0,
                finished: stats.finished || 0,
                dropped: stats.dropped || 0,
                total: library.length
            }
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// PATCH /api/users/:googleId/bio
router.patch('/users/:googleId/bio', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { bio } = req.body;
        if (bio === undefined) return errorResponse(res, 'bio is required', 400);
        const user = await User.findOneAndUpdate(
            { googleId },
            { bio: String(bio).trim().substring(0, 100) },
            { new: true }
        ).lean();
        if (!user) return errorResponse(res, 'User not found', 404);
        successResponse(res, { bio: user.bio });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// POST /api/users/:googleId/library
router.post('/users/:googleId/library', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { slug, mangaData } = req.body;
        if (!slug) return errorResponse(res, 'slug is required', 400);

        const user = await User.findOne({ googleId });
        if (!user) return errorResponse(res, 'User not found', 404);

        const existingIndex = user.library.findIndex(item => item.slug === slug);
        if (existingIndex >= 0) {
            user.library[existingIndex].mangaData = mangaData;
            user.library[existingIndex].addedAt = Date.now();
        } else {
            user.library.push({ slug, mangaData });
        }

        await user.save();
        // ✅ Hanya kembalikan konfirmasi, bukan seluruh array library
        successResponse(res, { message: 'Library berhasil diperbarui', slug });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// POST /api/users/:googleId/history
router.post('/users/:googleId/history', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { type, slug, title, thumb, lastChapterTitle, lastChapterSlug } = req.body;
        if (!slug) return errorResponse(res, 'slug is required', 400);

        const user = await User.findOne({ googleId });
        if (!user) return errorResponse(res, 'User not found', 404);

        const existingIndex = user.history.findIndex(item => item.slug === slug);
        if (existingIndex >= 0) {
            user.history[existingIndex].lastChapterTitle = lastChapterTitle;
            user.history[existingIndex].lastChapterSlug = lastChapterSlug;
            user.history[existingIndex].lastRead = Date.now();
            if (title) user.history[existingIndex].title = title;
            if (thumb) user.history[existingIndex].thumb = thumb;
        } else {
            user.history.push({ type, slug, title, thumb, lastChapterTitle, lastChapterSlug });
        }

        await user.save();
        // ✅ Hanya kembalikan konfirmasi, bukan seluruh array history
        successResponse(res, { message: 'History berhasil diperbarui', slug });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 5. USER DELETE ENDPOINTS
// ==========================================

router.delete('/users/:googleId/library/:slug', async (req, res) => {
    try {
        const { googleId, slug } = req.params;
        await User.updateOne({ googleId }, { $pull: { library: { slug } } }); // ✅ $pull lebih efisien dari load+filter+save
        successResponse(res, { message: 'Manga berhasil dihapus dari library' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

router.delete('/users/:googleId/library', async (req, res) => {
    try {
        const { googleId } = req.params;
        await User.updateOne({ googleId }, { $set: { library: [] } }); // ✅ $set langsung, tidak perlu load dulu
        successResponse(res, { message: 'Library berhasil dikosongkan' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

router.delete('/users/:googleId/history/:slug', async (req, res) => {
    try {
        const { googleId, slug } = req.params;
        await User.updateOne({ googleId }, { $pull: { history: { slug } } }); // ✅ $pull langsung
        successResponse(res, { message: 'Riwayat bacaan berhasil dihapus' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

router.delete('/users/:googleId/history', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { type } = req.query;

        if (type) {
            await User.updateOne({ googleId }, { $pull: { history: { type } } }); // ✅ $pull by type
        } else {
            await User.updateOne({ googleId }, { $set: { history: [] } });
        }

        successResponse(res, { message: 'Riwayat bacaan berhasil dibersihkan' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 6. DOWNLOAD LIMIT & PREMIUM ENDPOINTS
// ==========================================

router.post('/users/:googleId/download', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId })
            .select('isAdmin isPremium premiumUntil dailyDownloads downloadCount')
            .lean();
        if (!user) return errorResponse(res, 'User not found', 404);

        // Cek kadaluarsa premium
        if (!user.isAdmin && user.isPremium && user.premiumUntil) {
            if (new Date() > user.premiumUntil) {
                await User.updateOne({ googleId }, { $set: { isPremium: false, premiumUntil: null } });
                user.isPremium = false;
            }
        }

        if (user.isPremium || user.isAdmin) {
            return successResponse(res, { allowed: true, isPremium: true });
        }

        const today = new Date().toISOString().split('T')[0];
        const MAX_LIMIT = 20;

        const dailyDownloads = user.dailyDownloads || { date: '', count: 0 };
        const currentCount = dailyDownloads.date === today ? dailyDownloads.count : 0;

        if (currentCount >= MAX_LIMIT) {
            return successResponse(res, {
                allowed: false,
                current: currentCount,
                max: MAX_LIMIT,
                message: 'Batas unduhan harian (20) tercapai. Tunggu besok atau upgrade Premium!'
            });
        }

        // Update counter langsung di DB tanpa load full user
        await User.updateOne(
            { googleId },
            {
                $set: { 'dailyDownloads.date': today },
                $inc: { 'dailyDownloads.count': dailyDownloads.date !== today ? 0 : 1, downloadCount: 1 }
            }
        );

        // Jika tanggal baru, reset dulu count ke 1
        if (dailyDownloads.date !== today) {
            await User.updateOne({ googleId }, { $set: { 'dailyDownloads.count': 1 } });
        }

        successResponse(res, {
            allowed: true,
            current: currentCount + 1,
            max: MAX_LIMIT
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

router.post('/users/:googleId/set-premium', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { days } = req.body;
        if (!days) return errorResponse(res, 'Jumlah hari (days) diperlukan', 400);

        const expDate = new Date();
        expDate.setDate(expDate.getDate() + parseInt(days, 10));

        const newNotification = {
            title: 'Premium Diaktifkan!',
            message: `Admin telah mengaktifkan status Premium kamu selama ${days} hari. Nikmati fitur unduhan tanpa batas!`,
            isRead: false,
            createdAt: new Date()
        };

        // ✅ Update langsung tanpa load dulu — lebih ringan
        await User.updateOne(
            { googleId },
            {
                $set: { isPremium: true, premiumUntil: expDate },
                $push: { notifications: newNotification }
            }
        );

        successResponse(res, {
            message: `Premium berhasil diaktifkan selama ${days} hari`,
            premiumUntil: expDate
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 8. ADMIN ENDPOINTS
// ==========================================

const isAdmin = async (req, res, next) => {
    const { adminId } = req.body;
    const ADMIN_UIDS = ['BUkIZguy10hnIG8jAooZoycG7ak1'];
    if (!adminId || !ADMIN_UIDS.includes(adminId)) {
        return errorResponse(res, 'Akses ditolak. Hanya untuk Admin.', 403);
    }
    next();
};

router.post('/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { title, message } = req.body;
        if (!title || !message) return errorResponse(res, 'Judul dan pesan tidak boleh kosong', 400);

        const newNotification = { title, message, isRead: false, createdAt: new Date() };
        const result = await User.updateMany({}, { $push: { notifications: newNotification } });

        successResponse(res, {
            message: `Notifikasi berhasil dikirim ke ${result.modifiedCount} user.`
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 7. NOTIFICATION ENDPOINTS
// ==========================================

// ✅ Dengan pagination agar tidak kirim ratusan notifikasi sekaligus
router.get('/users/:googleId/notifications', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { page, limit, skip } = getPaginationParams(req, 20);

        const user = await User.findOne({ googleId }).select('notifications').lean();
        if (!user) return errorResponse(res, 'User not found', 404);

        const sorted = (user.notifications || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const paginated = sorted.slice(skip, skip + limit);

        successResponse(res, paginated, {
            currentPage: page,
            totalPages: Math.ceil(sorted.length / limit),
            totalItems: sorted.length,
            unreadCount: sorted.filter(n => !n.isRead).length,
            perPage: limit
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

router.put('/users/:googleId/notifications/read', async (req, res) => {
    try {
        const { googleId } = req.params;
        await User.updateOne({ googleId }, { $set: { 'notifications.$[].isRead': true } });
        successResponse(res, { message: 'All notifications marked as read' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// SETTINGS
// ==========================================

router.get('/settings/whatsapp', cacheMiddleware(300), async (req, res) => {
    try {
        const setting = await Settings.findOne({ key: 'whatsapp' }).lean();
        res.json({ success: true, whatsapp: setting ? setting.value : '6281234567890' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/settings/whatsapp', async (req, res) => {
    try {
        const { whatsapp } = req.body;
        await Settings.findOneAndUpdate(
            { key: 'whatsapp' },
            { value: whatsapp },
            { upsert: true }
        );
        invalidateCacheByPrefix('/api/settings/whatsapp');
        res.json({ success: true, whatsapp });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;