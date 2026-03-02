// --- 1. LOAD ENVIRONMENT VARIABLES (Wajib Paling Atas) ---
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
// Ambil PORT dari .env, kalau tidak ada pakai 3000
const PORT = process.env.PORT || 3000;

// --- 2. KONFIGURASI DATABASE (Ambil dari .env) ---
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("❌ FATAL ERROR: MONGODB_URI tidak ditemukan di file .env");
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Berhasil terkoneksi ke MongoDB Atlas'))
  .catch(err => {
    console.error('❌ Gagal koneksi ke MongoDB:', err);
    process.exit(1);
  });

// --- IMPORT ROUTES & MODELS ---
const apiRoutes = require('./routes/api');
// ✨ PERBAIKAN: Mengimpor model Manga agar bisa digunakan di rute

// --- 3. CONFIG & MIDDLEWARE UTAMA ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- 4. RUTE APLIKASI ---

// Rute API
app.use('/api', apiRoutes);

// Home Page
app.get('/', async (req, res) => {
  try {
    // Sekarang Node.js sudah tahu apa itu 'Manga'
    const mangas = await Manga.find().sort({ lastUpdated: -1 });
    res.render('index', { mangas });
  } catch (error) {
    console.error("Error di Home Page:", error);
    res.status(500).send("Error membuka halaman utama.");
  }
});

// ==========================================
//           404 NOT FOUND MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
  res.status(404).render('404', { url: req.originalUrl });
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});