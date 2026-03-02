// File: services/googleIndexer.js
const { google } = require('googleapis');
const path = require('path');

// Arahkan ke lokasi file JSON yang kamu download dari Google Cloud
const KEY_PATH = path.join(__dirname, '../google-key.json'); 

async function requestGoogleIndex(url) {
    try {
        // Cara yang lebih modern dan aman dari error "No key or keyFile set"
        const auth = new google.auth.GoogleAuth({
            keyFile: KEY_PATH,
            scopes: ['https://www.googleapis.com/auth/indexing'],
        });

        // Dapatkan client yang sudah ter-otentikasi
        const authClient = await auth.getClient();

        // Inisialisasi API Indexing
        const indexing = google.indexing({
            version: 'v3',
            auth: authClient,
        });

        // Kirim permintaan indexing (URL_UPDATED berlaku untuk halaman baru & update)
        const response = await indexing.urlNotifications.publish({
            requestBody: {
                url: url,
                type: 'URL_UPDATED',
            },
        });

        console.log(`✅ [Google Index] Berhasil mengirim URL ke Google: ${url}`);
        return response.data;
    } catch (error) {
        console.error(`❌ [Google Index Error] Gagal mengirim ${url}:`, error.message);
        return null;
    }
}

module.exports = { requestGoogleIndex };