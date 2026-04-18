import axios from 'axios';
import QRCode from 'qrcode';
import dotenv from 'dotenv';

dotenv.config();

class AtlanticService {
    constructor() {
        this.apiKey = process.env.ATLANTIC_API_KEY;
        this.baseURL = process.env.ATLANTIC_API_URL || 'https://atlantich2h.com/';
        this.timeout = 30000;
        this.debug = process.env.ATLANTIC_DEBUG_MODE === 'true';
        
        // Store untuk tracking deposits (in-memory)
        this.activeDeposits = new Map();
        
        console.log('🔄 Atlantic Service Initialized');
    }

    async generateQRCode(qrString, options = {}) {
        try {
            const defaultOptions = {
                errorCorrectionLevel: 'H',
                type: 'png',
                margin: 2,
                width: 400,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            };
            
            const qrOptions = { ...defaultOptions, ...options };
            const qrBuffer = await QRCode.toBuffer(qrString, qrOptions);
            return qrBuffer;
        } catch (error) {
            console.error('❌ QR Code generation error:', error.message);
            throw new Error(`Gagal generate QR code: ${error.message}`);
        }
    }

    async createQRISDeposit(params) {
        try {
            const { reff_id, nominal, user_id } = params;
            
            console.log(`📤 Creating deposit: ${nominal} for ${user_id}`);
            
            const endpoint = '/deposit/create';
            const requestData = {
                api_key: this.apiKey,
                reff_id: reff_id,
                nominal: nominal,
                type: 'ewallet',
                metode: 'qris'
            };
            
            const requiredFields = ['reff_id', 'nominal'];
            for (const field of requiredFields) {
                if (!params[field]) {
                    throw new Error(`Field ${field} diperlukan`);
                }
            }
            
            if (params.nominal < 1000) {
                throw new Error('Nominal minimal Rp 1.000');
            }
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Gagal membuat deposit');
            }
            
            const depositData = response.data.data;
            
            // Generate QR Code
            let qrBase64 = null;
            if (depositData.qr_string) {
                try {
                    const qrBuffer = await this.generateQRCode(depositData.qr_string);
                    qrBase64 = `data:image/png;base64,${qrBuffer.toString('base64')}`;
                } catch (qrError) {
                    console.warn('⚠️ Failed to generate QR:', qrError.message);
                }
            }
            
            // Simpan data deposit aktif
            this.activeDeposits.set(depositData.id, {
                id: depositData.id,
                reffId: reff_id,
                nominal: nominal,
                userId: user_id,
                status: 'pending',
                createdAt: Date.now(),
                qrString: depositData.qr_string,
                qrBase64: qrBase64
            });
            
            return {
                success: true,
                data: {
                    ...depositData,
                    qr_base64: qrBase64,
                    user_id: user_id,
                    reff_id: reff_id
                },
                message: 'Deposit berhasil dibuat'
            };
            
        } catch (error) {
            console.error('❌ Create deposit error:', error.message);
            
            let errorMessage = 'Terjadi kesalahan';
            if (error.response?.data?.message) {
                errorMessage = error.response.data.message;
            } else if (error.code === 'ECONNABORTED') {
                errorMessage = 'Timeout: Server tidak merespon';
            }
            
            return {
                success: false,
                message: errorMessage
            };
        }
    }

    async checkDepositStatus(depositId) {
        try {
            console.log(`🔍 Checking status: ${depositId}`);
            
            const endpoint = '/deposit/status';
            const requestData = {
                api_key: this.apiKey,
                id: depositId
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Deposit tidak ditemukan');
            }
            
            // Update status in memory
            const deposit = this.activeDeposits.get(depositId);
            if (deposit) {
                deposit.status = response.data.data.status;
            }
            
            return {
                success: true,
                data: response.data.data,
                message: 'Status berhasil dicek'
            };
            
        } catch (error) {
            console.error('❌ Status check error:', error.message);
            return {
                success: false,
                message: error.response?.data?.message || 'Gagal mengecek status'
            };
        }
    }

    async checkInstantDeposit(depositId, action = true) {
        try {
            console.log(`⚡ Checking instant deposit: ${depositId}, action: ${action}`);
            
            const endpoint = '/deposit/instant';
            const requestData = {
                api_key: this.apiKey,
                id: depositId,
                action: action ? 'true' : 'false'
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Gagal cek status instan');
            }
            
            // Update status in memory
            const deposit = this.activeDeposits.get(depositId);
            if (deposit) {
                deposit.status = response.data.data.status;
            }
            
            return {
                success: true,
                data: response.data.data,
                message: 'Status instan berhasil dicek'
            };
            
        } catch (error) {
            console.error('❌ Instant check error:', error.message);
            return {
                success: false,
                message: error.response?.data?.message || 'Gagal mengecek status instan'
            };
        }
    }

    async getProfile() {
        try {
            console.log('👤 Getting profile info...');
            
            const endpoint = '/get_profile';
            const requestData = {
                api_key: this.apiKey
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Gagal mendapatkan profile');
            }
            
            return {
                success: true,
                data: response.data.data,
                message: 'Profile berhasil didapatkan'
            };
            
        } catch (error) {
            console.error('❌ Get profile error:', error.message);
            return {
                success: false,
                message: error.response?.data?.message || 'Gagal mendapatkan profile'
            };
        }
    }

    getActiveDeposit(depositId) {
        return this.activeDeposits.get(depositId);
    }

    getAllActiveDeposits() {
        return Array.from(this.activeDeposits.values());
    }

    removeActiveDeposit(depositId) {
        this.activeDeposits.delete(depositId);
    }
}

export default AtlanticService;
