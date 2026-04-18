import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import QRCode from 'qrcode';
import session from 'express-session';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Konfigurasi
const ATLANTIC_API_KEY = process.env.ATLANTIC_API_KEY;
const ATLANTIC_API_URL = process.env.ATLANTIC_API_URL || 'https://atlantich2h.com';
const QRIS_EXPIRY_SECONDS = 59 * 60 + 28; // 59 menit 28 detik
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// In-memory storage
const activeDeposits = new Map();
const adminSessions = new Map();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'atlantic-qris-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 jam
    }
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

// Serve static files
app.use(express.static(path.join(__dirname, '../frontend')));

// Helper functions
function generateReffId() {
    return `WEB${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

function generateTransferRefId() {
    return `TRF${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

async function generateQRCodeBase64(qrString) {
    try {
        const qrBuffer = await QRCode.toBuffer(qrString, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 400,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        return `data:image/png;base64,${qrBuffer.toString('base64')}`;
    } catch (error) {
        console.error('QR Error:', error.message);
        return null;
    }
}

async function callAtlanticAPI(endpoint, data) {
    try {
        // Log request untuk debugging
        console.log(`📤 API Request to ${endpoint}:`, JSON.stringify(data, null, 2));
        
        const formData = new URLSearchParams();
        
        // Selalu tambahkan api_key
        formData.append('api_key', ATLANTIC_API_KEY);
        
        // Tambahkan semua parameter
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null && value !== '') {
                formData.append(key, value);
            }
        }
        
        const response = await axios.post(`${ATLANTIC_API_URL}${endpoint}`, formData.toString(), {
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'User-Agent': 'Atlantic-Web-Client/1.0'
            },
            timeout: 30000
        });
        
        console.log(`📥 API Response from ${endpoint}:`, JSON.stringify(response.data, null, 2));
        
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`❌ API Error (${endpoint}):`, error.message);
        
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
            
            // Handle 403 dengan lebih baik
            if (error.response.status === 403) {
                return { 
                    success: false, 
                    message: 'API Key tidak memiliki izin untuk endpoint ini. Periksa kembali API Key Anda atau hubungi support Atlantic.',
                    statusCode: 403,
                    data: error.response.data
                };
            }
            
            return { 
                success: false, 
                message: error.response.data?.message || `HTTP ${error.response.status}: ${error.response.statusText}`,
                statusCode: error.response.status,
                data: error.response.data
            };
        } else if (error.code === 'ECONNABORTED') {
            return { success: false, message: 'Timeout: Server tidak merespon' };
        } else if (error.code === 'ECONNREFUSED') {
            return { success: false, message: 'Koneksi ditolak: Server tidak dapat dijangkau' };
        }
        
        return { success: false, message: error.message };
    }
}

// Admin authentication middleware
function requireAdmin(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Unauthorized: Admin login required' });
    }
}

// ==================== PUBLIC API ROUTES (No Auth) ====================

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        req.session.loginTime = Date.now();
        
        res.json({ 
            success: true, 
            message: 'Login berhasil',
            data: { username: ADMIN_USERNAME }
        });
    } else {
        res.status(401).json({ success: false, message: 'Username atau password salah' });
    }
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logout berhasil' });
});

// Check admin session
app.get('/api/admin/check', (req, res) => {
    res.json({ 
        success: true, 
        isAdmin: req.session.isAdmin || false 
    });
});

// CREATE DEPOSIT (Public - for users)
app.post('/api/deposit/create', async (req, res) => {
    try {
        const { nominal, user_name } = req.body;
        
        if (!nominal || nominal < 1000) {
            return res.status(400).json({ success: false, message: 'Nominal minimal Rp 1.000' });
        }
        if (nominal > 10000000) {
            return res.status(400).json({ success: false, message: 'Nominal maksimal Rp 10.000.000' });
        }

        const reffId = generateReffId();
        const expiredAt = Date.now() + (QRIS_EXPIRY_SECONDS * 1000);
        
        const result = await callAtlanticAPI('/deposit/create', {
            reff_id: reffId,
            nominal: nominal,
            type: 'ewallet',
            metode: 'qris'
        });

        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal membuat deposit' });
        }

        const depositData = result.data.data;
        const qrBase64 = await generateQRCodeBase64(depositData.qr_string);

        activeDeposits.set(depositData.id, {
            id: depositData.id,
            reffId: reffId,
            nominal: nominal,
            userName: user_name || 'Customer',
            status: 'pending',
            createdAt: Date.now(),
            expiredAt: expiredAt,
            qrString: depositData.qr_string
        });

        res.json({
            success: true,
            data: {
                id: depositData.id,
                reff_id: reffId,
                nominal: depositData.nominal,
                qr_string: depositData.qr_string,
                qr_base64: qrBase64,
                status: 'pending',
                expired_at: expiredAt,
                expired_seconds: QRIS_EXPIRY_SECONDS
            }
        });
    } catch (error) {
        console.error('Create deposit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// CHECK STATUS (Public)
app.get('/api/deposit/status/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const deposit = activeDeposits.get(id);
        if (deposit && deposit.expiredAt < Date.now() && deposit.status === 'pending') {
            deposit.status = 'expired';
            return res.json({ success: true, data: { id, nominal: deposit.nominal, status: 'expired' } });
        }
        
        const result = await callAtlanticAPI('/deposit/status', { id });
        
        if (!result.success || !result.data.status) {
            return res.status(404).json({ success: false, message: result.data?.message || 'Deposit tidak ditemukan' });
        }

        const status = result.data.data.status;
        if (activeDeposits.has(id)) {
            activeDeposits.get(id).status = status;
        }

        res.json({ success: true, data: { id: result.data.data.id, nominal: result.data.data.nominal, status: status } });
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengecek status' });
    }
});

// INSTANT CHECK (Public)
app.post('/api/deposit/instant', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, message: 'Deposit ID required' });
        
        const deposit = activeDeposits.get(id);
        if (deposit && deposit.expiredAt < Date.now() && deposit.status === 'pending') {
            deposit.status = 'expired';
            return res.json({ success: true, data: { id, nominal: deposit.nominal, status: 'expired', instant: true, action: true } });
        }
        
        const result = await callAtlanticAPI('/deposit/instant', { id: id, action: 'true' });
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Instant check gagal' });
        }

        const status = result.data.data.status;
        if (activeDeposits.has(id)) {
            activeDeposits.get(id).status = status;
        }

        res.json({ success: true, data: { id: result.data.data.id, nominal: result.data.data.nominal, status: status, instant: true, action: true } });
    } catch (error) {
        console.error('Instant check error:', error);
        res.status(500).json({ success: false, message: 'Gagal instant check' });
    }
});

// CANCEL DEPOSIT (Public)
app.post('/api/deposit/cancel', async (req, res) => {
    try {
        const { id } = req.body;
        
        const result = await callAtlanticAPI('/deposit/cancel', { id });
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal membatalkan' });
        }

        if (activeDeposits.has(id)) {
            activeDeposits.get(id).status = 'cancelled';
        }
        
        res.json({ success: true, message: 'Deposit berhasil dibatalkan' });
    } catch (error) {
        console.error('Cancel error:', error);
        res.status(500).json({ success: false, message: 'Gagal membatalkan' });
    }
});

// GET ALL ACTIVE DEPOSITS (Public - for display)
app.get('/api/deposits/active', (req, res) => {
    const deposits = Array.from(activeDeposits.values()).filter(d => d.status === 'pending');
    res.json({ success: true, data: deposits, count: deposits.length });
});

// GET PROFILE (Public - limited info)
app.get('/api/profile', async (req, res) => {
    try {
        const result = await callAtlanticAPI('/get_profile', {});
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal mengambil profile' });
        }
        
        // Hanya kirim balance untuk public
        res.json({ 
            success: true, 
            data: {
                balance: result.data.data?.balance || '0'
            }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil profile' });
    }
});

// ==================== ADMIN ONLY API ROUTES ====================

// GET PROFILE (Admin only - complete profile)
app.get('/api/admin/profile', requireAdmin, async (req, res) => {
    try {
        const result = await callAtlanticAPI('/get_profile', {});
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal mengambil profile' });
        }
        
        res.json({ 
            success: true, 
            data: {
                name: result.data.data?.name || 'N/A',
                username: result.data.data?.username || 'N/A',
                email: result.data.data?.email || 'N/A',
                phone: result.data.data?.phone || 'N/A',
                balance: result.data.data?.balance || '0',
                status: result.data.data?.status || 'active'
            }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil profile' });
    }
});

// GET BALANCE DETAIL (Admin only)
app.get('/api/admin/balance', requireAdmin, async (req, res) => {
    try {
        const result = await callAtlanticAPI('/get_balance', {});
        
        if (!result.success) {
            // Fallback ke get_profile
            const profileResult = await callAtlanticAPI('/get_profile', {});
            if (profileResult.success && profileResult.data.status) {
                return res.json({ 
                    success: true, 
                    data: { balance: profileResult.data.data?.balance || '0' }
                });
            }
            return res.status(400).json({ success: false, message: result.message });
        }
        
        res.json({ success: true, data: result.data.data });
    } catch (error) {
        console.error('Balance error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil saldo' });
    }
});

// TRANSFER (Admin only) - FIXED VERSION
app.post('/api/admin/transfer', requireAdmin, async (req, res) => {
    try {
        const { ref_id, kode_bank, nomor_akun, nama_pemilik, nominal, email, phone, note } = req.body;
        
        // Validasi input
        if (!ref_id) return res.status(400).json({ success: false, message: 'Reference ID diperlukan' });
        if (!kode_bank) return res.status(400).json({ success: false, message: 'Kode bank diperlukan' });
        if (!nomor_akun) return res.status(400).json({ success: false, message: 'Nomor rekening diperlukan' });
        if (!nama_pemilik) return res.status(400).json({ success: false, message: 'Nama pemilik diperlukan' });
        if (!nominal || nominal < 10000) return res.status(400).json({ success: false, message: 'Nominal minimal Rp 10.000' });
        
        const nominalInt = parseInt(nominal);
        if (isNaN(nominalInt)) return res.status(400).json({ success: false, message: 'Nominal harus berupa angka' });
        
        // Hitung fee (2% dengan minimal 2000, maksimal 25000)
        const fee = Math.min(25000, Math.max(2000, Math.round(nominalInt * 0.02)));
        const total = nominalInt + fee;
        
        // Cek saldo terlebih dahulu
        const profileResult = await callAtlanticAPI('/get_profile', {});
        let currentBalance = 0;
        
        if (profileResult.success && profileResult.data.status) {
            currentBalance = parseInt(profileResult.data.data?.balance || '0');
            console.log(`💰 Current Balance: ${formatRupiah(currentBalance)}`);
            console.log(`💰 Needed: ${formatRupiah(total)}`);
            
            if (currentBalance < total) {
                return res.status(400).json({ 
                    success: false, 
                    message: `Saldo tidak mencukupi! Saldo: ${formatRupiah(currentBalance)}, Dibutuhkan: ${formatRupiah(total)} (termasuk fee ${formatRupiah(fee)})`,
                    balance: currentBalance,
                    needed: total,
                    fee: fee
                });
            }
        }
        
        // Tentukan jenis transfer (bank atau ewallet)
        const ewalletCodes = ['dana', 'ovo', 'gopay', 'shopeepay', 'linkaja', 'qris', 'sakuku'];
        const isEwallet = ewalletCodes.includes(kode_bank.toLowerCase());
        
        // Data untuk API transfer - COBA BERBAGAI FORMAT
        const transferData = {
            ref_id: ref_id,
            kode_bank: kode_bank.toLowerCase(),
            nomor_akun: nomor_akun,
            nama_pemilik: nama_pemilik,
            nominal: nominalInt.toString(),
            amount: nominalInt.toString(),
            email: email || '',
            phone: phone || '',
            note: note || `Transfer via Web Admin - ${new Date().toLocaleString('id-ID')}`,
            type: isEwallet ? 'ewallet' : 'bank'
        };
        
        console.log('📤 Admin Transfer Data:', transferData);
        
        // Coba beberapa endpoint jika yang pertama gagal
        const endpoints = [
            '/transfer/create',
            '/trx/create', 
            '/transfer/send',
            '/transaction/transfer',
            '/send/transfer'
        ];
        
        let result = null;
        let lastError = null;
        
        for (const endpoint of endpoints) {
            console.log(`🔄 Trying endpoint: ${endpoint}`);
            result = await callAtlanticAPI(endpoint, transferData);
            
            if (result.success && result.data.status === true) {
                console.log(`✅ Success with endpoint: ${endpoint}`);
                break;
            } else if (result.statusCode === 403) {
                console.log(`⚠️ Endpoint ${endpoint} returned 403, trying next...`);
                lastError = result;
                result = null;
            } else if (result.success && result.data.status === false) {
                console.log(`⚠️ Endpoint ${endpoint} returned false: ${result.data.message}`);
                lastError = result;
                result = null;
            } else {
                lastError = result;
                result = null;
            }
        }
        
        if (!result) {
            // Jika semua endpoint gagal, berikan pesan yang lebih informatif
            const errorMessage = lastError?.statusCode === 403 
                ? 'API Key tidak memiliki izin untuk melakukan transfer. Fitur transfer mungkin tidak tersedia untuk API key ini. Silakan gunakan fitur QRIS Deposit saja.'
                : (lastError?.message || 'Gagal melakukan transfer. Pastikan API Key memiliki izin transfer.');
            
            return res.status(400).json({ 
                success: false, 
                message: errorMessage,
                suggestion: 'Jika Anda membutuhkan fitur transfer, silakan hubungi support Atlantic untuk mengaktifkan izin transfer pada API key Anda.'
            });
        }
        
        const transferResult = result.data.data || result.data;
        
        res.json({
            success: true,
            message: 'Transfer berhasil diproses',
            data: {
                id: transferResult.id || transferResult.transaction_id,
                reff_id: transferResult.reff_id || ref_id,
                status: transferResult.status || 'pending',
                name: transferResult.name || nama_pemilik,
                nomor_tujuan: transferResult.nomor_tujuan || nomor_akun,
                nominal: nominalInt,
                fee: fee,
                total: total,
                created_at: transferResult.created_at || new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('❌ Transfer error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Terjadi kesalahan saat transfer: ' + error.message 
        });
    }
});

// CHECK TRANSFER STATUS (Admin only)
app.post('/api/admin/transfer/status', requireAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        
        if (!id) {
            return res.status(400).json({ success: false, message: 'ID transaksi diperlukan' });
        }
        
        const endpoints = ['/transfer/status', '/trx/status', '/transaction/status'];
        let result = null;
        
        for (const endpoint of endpoints) {
            result = await callAtlanticAPI(endpoint, { id });
            if (result.success && result.data.status) {
                break;
            }
        }
        
        if (!result || !result.success || !result.data.status) {
            return res.status(404).json({ success: false, message: result?.data?.message || 'Transaksi tidak ditemukan' });
        }
        
        res.json({
            success: true,
            data: result.data.data
        });
        
    } catch (error) {
        console.error('Transfer status error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengecek status transfer' });
    }
});

// GET BANK LIST (Admin only)
app.get('/api/admin/banks', requireAdmin, async (req, res) => {
    try {
        const result = await callAtlanticAPI('/transfer/bank_list', {});
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal mengambil daftar bank' });
        }
        
        res.json({
            success: true,
            data: result.data.data || []
        });
        
    } catch (error) {
        console.error('Bank list error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil daftar bank' });
    }
});

// CHECK ACCOUNT (Admin only)
app.post('/api/admin/check-account', requireAdmin, async (req, res) => {
    try {
        const { bank_code, account_number } = req.body;
        
        if (!bank_code || !account_number) {
            return res.status(400).json({ success: false, message: 'Kode bank dan nomor rekening diperlukan' });
        }
        
        const result = await callAtlanticAPI('/transfer/cek_rekening', {
            bank_code: bank_code.toLowerCase(),
            account_number: account_number
        });
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal mengecek rekening' });
        }
        
        res.json({
            success: true,
            data: {
                bank_code: bank_code,
                account_number: account_number,
                account_name: result.data.data?.account_name || 'Tidak diketahui',
                valid: true
            }
        });
        
    } catch (error) {
        console.error('Check account error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengecek rekening' });
    }
});

// GET ALL DEPOSITS (Admin only - complete list)
app.get('/api/admin/deposits/all', requireAdmin, (req, res) => {
    const deposits = Array.from(activeDeposits.values());
    res.json({ success: true, data: deposits, count: deposits.length });
});

// DELETE DEPOSIT (Admin only)
app.delete('/api/admin/deposit/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    if (activeDeposits.has(id)) {
        activeDeposits.delete(id);
        res.json({ success: true, message: 'Deposit dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Deposit tidak ditemukan' });
    }
});

// Format Rupiah helper
function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

// Fallback route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..index.html'));
});

app.listen(PORT, () => {
    console.log(`
    
                    WEB ATLANTIC
          Running on http://localhost:${PORT}       
                🔐 ADMIN LOGIN:                     
              Username: ${ADMIN_USERNAME}   
              Password: ${ADMIN_PASSWORD}
    `);
});
