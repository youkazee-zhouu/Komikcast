// models/User.js
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    title: String,
    message: String,
    isRead: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

// 1. Buat Schema untuk History
const historySchema = new mongoose.Schema({
    type: String, // Contoh: 'manga', 'manhwa'
    slug: String,
    title: String,
    thumb: String,
    lastChapterTitle: String,
    lastChapterSlug: String,
    lastRead: { type: Date, default: Date.now }
});

// 2. Buat Schema untuk Library
const librarySchema = new mongoose.Schema({
    slug: { type: String, required: true },
    
    // Karena di Flutter kamu menggunakan manga.toJson(), 
    // kamu bisa menggunakan tipe Mixed untuk menyimpan object JSON yang dinamis.
    mangaData: { type: mongoose.Schema.Types.Mixed }, 
    
    addedAt: { type: Date, default: Date.now }
});

// 3. Schema User Utama
const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    displayName: String,
    photoURL: { type: String, default: '' },  // Foto profil dari Firebase Auth
    bio: { type: String, default: '', maxlength: 100 }, // Bio publik user

    // --- FITUR PREMIUM & LIMIT BARU ---
    isAdmin: { type: Boolean, default: false },
    isPremium: { type: Boolean, default: false },
    premiumUntil: { type: Date, default: null }, // Kapan premium berakhir
    dailyDownloads: {
        date: { type: String, default: "" }, // Format: YYYY-MM-DD
        count: { type: Number, default: 0 }
    },
    
    downloadCount: { type: Number, default: 0 }, // Total download seumur hidup (opsional)
    lastDownloadDate: { type: Date, default: Date.now },
    
    // --- TAMBAHKAN ARRAY NOTIFIKASI DI SINI ---
    notifications: [notificationSchema], 
    
    history: [historySchema],
    library: [librarySchema]
});

module.exports = mongoose.model('User', userSchema);
