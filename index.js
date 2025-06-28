const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require("qrcode-terminal");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const pino = require('pino');
require("dotenv").config();

// -- Konfigurasi Gemini API --
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.error("ERROR: Harap isi API Key Gemini Anda di bagian Secrets. Bot tidak akan berjalan.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// --- KONFIGURASI GOOGLE SHEETS MENGGUNAKAN GOOGLEAPIS ---
const spreadsheetId = process.env.SPREADSHEET_ID;
const serviceAccountCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS;

if (!spreadsheetId) {
    console.error("ERROR: Harap isi SPREADSHEET_ID Anda di bagian Secrets. Bot tidak akan berjalan.");
    process.exit(1);
}

if (!serviceAccountCredentials) {
    console.error("ERROR: Harap tambahkan GOOGLE_SERVICE_ACCOUNT_CREDENTIALS di Secrets.");
    process.exit(1);
}

// Konfigurasi otentikasi JWT menggunakan kredensial dari Secrets
const credentials = JSON.parse(serviceAccountCredentials);
const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Inisialisasi Google Sheets API client
const sheets = google.sheets({ version: 'v4', auth });
// --- AKHIR KONFIGURASI GOOGLE SHEETS ---

// --- FUNGSI UNTUK MEMBACA DATA DARI SHEETS ---
async function getSheetData(sheetName, range) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!${range}`,
        });
        return response.data.values || [];
    } catch (error) {
        console.error(`ERROR: Gagal membaca data dari sheet '${sheetName}'.`, error);
        return null;
    }
}
// --- AKHIR FUNGSI UNTUK MEMBACA DATA DARI SHEETS ---

// -- Inisialisasi Bot Baileys --
async function connectToWhatsApp() {
    // --- BAGIAN KONEKSI: Uji koneksi ke spreadsheet menggunakan googleapis ---
    try {
        const sheetInfo = await sheets.spreadsheets.get({
            spreadsheetId,
            auth,
        });
        console.log("Spreadsheet berhasil dimuat! Nama:", sheetInfo.data.properties.title);
    } catch (error) {
        console.error("ERROR: Gagal terhubung ke Google Sheets menggunakan googleapis. Pastikan ID dan kredensial sudah benar dan spreadsheet sudah dibagikan ke Service Account.", error);
        return;
    }
    // --- AKHIR BAGIAN KONEKSI ---

    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'warn' }), 
        browser: ['Baileys-Gemini-Bot', 'Desktop', '3.0.0']
    });

    // --- Event Handlers ---

    // Event saat menerima QR code atau status koneksi berubah
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log("--- SILAKAN SCAN QR CODE INI ---");
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus karena', lastDisconnect.error, ', menyambung ulang:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Koneksi terbuka!');
        }
    });

    // Event saat credentials diupdate (untuk menyimpan sesi)
    sock.ev.on('creds.update', saveCreds);

    // Event saat menerima pesan
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        // Pastikan pesan valid, bukan dari bot sendiri, dan bukan dari status broadcast
        if (!m.message || m.key.fromMe || m.key.remoteJid === 'status@broadcast') return;

        // --- Mulai Logika Kontrol Akses ---
        const allowedNumbers = process.env.ALLOWED_NUMBERS.split(',').map(num => num.trim() + '@s.whatsapp.net');
        const sender = m.key.remoteJid;

        if (!allowedNumbers.includes(sender)) {
            console.log(`[ACCESS DENIED] Pesan dari nomor tidak diizinkan: ${sender}`);
            return;
        }

        console.log(`[ACCESS GRANTED] Pesan diterima dari nomor yang diizinkan: ${sender}`);
        // --- Akhir Logika Kontrol Akses ---

        // --- Logika Pembersihan Pesan ---
        let messageText = m.message.conversation || m.message.extendedTextMessage?.text || '';
        if (m.key.remoteJid.endsWith('@g.us')) {
            messageText = messageText.replace(/@\d+/g, '').trim();
        }
        console.log("Pesan Diterima (setelah dibersihkan):", messageText);
        if (messageText === '') return;
        // --- Akhir Logika Pembersihan Pesan ---

        // --- MULAI LOGIKA PERINTAH ---
        if (messageText.toLowerCase().replace(/\s/g, '') === '!cekstok') { 
            console.log('Perintah !cekstok diterima.');
            try {
                const productNames = await getSheetData('JUMLAH', 'C4:C');
                const stockQuantities = await getSheetData('JUMLAH', 'D4:D');

                if (!productNames || !stockQuantities) {
                    await sock.sendMessage(sender, { text: 'Maaf, gagal mengambil data stok. Mohon cek konfigurasi sheet.' });
                    return;
                }

                let stockMessage = 'Berikut daftar stok produk saat ini:\n\n';
                for (let i = 0; i < productNames.length; i++) {
                    const productName = productNames[i] ? productNames[i][0] : '';
                    const stock = stockQuantities[i] ? stockQuantities[i][0] : 'N/A';
                    if (productName) {
                        stockMessage += `${i + 1}. ${productName}: *${stock}*\n`;
                    }
                }
                stockMessage += '\nUntuk melihat detail, ketik `!detail <nama_produk>`.';

                await sock.sendMessage(sender, { text: stockMessage });
                console.log("Respon stok dikirim.");
            } catch (error) {
                console.error("Error saat membaca data stok:", error);
                await sock.sendMessage(sender, { text: "Maaf, terjadi kesalahan saat mencoba mendapatkan data stok." });
            }
        } 
        // --- LOGIKA PERINTAH LAIN ---
        else if (messageText.toLowerCase().startsWith('!detail ')) {
            await sock.sendMessage(sender, { text: "Fitur detail produk sedang dalam pengembangan. Mohon tunggu." });
        }
        // --- AKHIR LOGIKA PERINTAH ---

        // --- MULAI LOGIKA PEMBERIAN KONTEKS DARI BEBERAPA SHEET ---
        else {
            try {
                // BARIS DIUBAH: Definisikan SEMUA sheet yang ingin dibaca dan rentangnya
                // PENTING: Mohon sesuaikan 'range' untuk setiap sheet agar sesuai dengan data Anda
                const sheetsToFetch = [
                    { name: 'JUMLAH', range: 'C4:D' }, 
                    { name: 'OFFLINE', range: 'A2:Z' }, // <-- HARUS DISESUAIKAN: Ganti 'A2:Z' dengan rentang data Anda
                    { name: 'RUSUNAWA', range: 'A2:Z' },// <-- HARUS DISESUAIKAN: Ganti 'A2:Z' dengan rentang data Anda
                    { name: 'JOBDESK', range: 'A2:Z' }, // <-- HARUS DISESUAIKAN: Ganti 'A2:Z' dengan rentang data Anda
                    { name: 'AKUN', range: 'A2:Z' },    // <-- HARUS DISESUAIKAN: Ganti 'A2:Z' dengan rentang data Anda
                    { name: 'STOCK', range: 'A2:Z' },   // <-- HARUS DISESUAIKAN: Ganti 'A2:Z' dengan rentang data Anda
                    { name: 'JUNI 2025', range: 'A2:Z' } // <-- HARUS DISESUAIKAN: Ganti 'A2:Z' dengan rentang data Anda
                ];

                let allContextData = '';

                for (const sheet of sheetsToFetch) {
                    const sheetData = await getSheetData(sheet.name, sheet.range);

                    let sheetContext = `--- Data from sheet '${sheet.name}' ---\n`;
                    if (sheetData && sheetData.length > 0) {
                        // BARIS BARU: Menambahkan header kolom untuk setiap sheet
                        const headers = sheetData[0] || [];
                        const rows = sheetData.slice(1);

                        sheetContext += `Headers: ${headers.join(', ')}\n`;
                        sheetContext += rows.map(row => `Row: ${row.join(', ')}`).join('\n');
                    } else {
                        sheetContext += `No data available in this sheet.`;
                    }
                    sheetContext += '\n\n';
                    allContextData += sheetContext;
                }

                // BARIS DIUBAH: Prompt yang lebih fleksibel untuk banyak sheet
                const prompt = `Kamu adalah asisten AI yang bertugas menjawab pertanyaan pengguna.
                Kamu memiliki akses ke data dari berbagai sheet Google Spreadsheet.

                Berikut adalah data yang diambil langsung dari beberapa sheet. Setiap sheet ditandai dengan nama sheetnya:
                --- DATA SPREADSHEET ---
                ${allContextData}
                --- AKHIR DATA ---

                Peraturan:
                1. Jawab pertanyaan pengguna HANYA berdasarkan data yang ada di bagian "DATA SPREADSHEET".
                2. Sebutkan nama sheet dari mana informasi itu berasal.
                3. Jangan membuat asumsi tentang data lain yang tidak diberikan.
                4. Jika informasi yang ditanya pengguna tidak ada dalam data, katakan dengan sopan bahwa Anda tidak dapat menemukan informasi tersebut di spreadsheet.
                5. Jaga percakapan tetap relevan dan profesional.
                6. Jawab dalam bahasa yang digunakan pengguna (Indonesia atau Sunda).

                Pertanyaan pengguna: ${messageText}`;

                // Kirim prompt ke model Gemini
                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();

                // Kirim balasan
                await sock.sendMessage(sender, { text: text });
                console.log("Respon Gemini:", text);
            } catch (error) {
                console.error("Error saat berinteraksi dengan Gemini:", error);
                await sock.sendMessage(sender, { text: "Maaf, ada masalah saat memproses permintaan Anda." });
            }
        }
    });
}

// Jalankan fungsi untuk memulai bot
connectToWhatsApp();