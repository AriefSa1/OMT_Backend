require('dotenv').config();
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./dev.db';
}
const express = require('express');
const path = require('path');
const cors = require('cors');

const configService = require('./src/services/configService');
const aiService = require('./src/services/aiService');
const shopeeService = require('./src/services/shopeeService');
const warehouseService = require('./src/services/warehouseService');
const { initCronJobs } = require('./src/cron/syncCron');

const { securityHeaders } = require('./src/middleware/securityHeaders');
const { createRateLimiter } = require('./src/middleware/rateLimit');

const authRoutes = require('./src/routes/authRoutes');
const settingsRoutes = require('./src/routes/settingsRoutes');
const shopeeRoutes = require('./src/routes/shopeeRoutes');
const warehouseRoutes = require('./src/routes/warehouseRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');
const optimizationRoutes = require('./src/routes/optimizationRoutes');
const aiRoutes = require('./src/routes/aiRoutes');
const statusRoutes = require('./src/routes/statusRoutes');
const syncRoutes = require('./src/routes/syncRoutes');
const growthIntelligenceRoutes = require('./src/routes/growthIntelligenceRoutes');
const taskRoutes = require('./src/routes/taskRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const accountRoutes = require('./src/routes/accountRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Render menaruh server di belakang proxy. Tanpa ini, req.ip berisi IP proxy (sama untuk
// semua orang) sehingga rate limit per-IP tak berguna, dan Express bisa salah menilai
// koneksi sebagai tidak-aman. Satu hop proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');

const allowedOriginsConfig = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
  : [];

const defaultAllowedOrigins = [
  'https://94media.art',
  'https://www.94media.art',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...allowedOriginsConfig]));

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    const cleanOrigin = origin.replace(/\/$/, '');
    if (
      allowedOrigins.includes(cleanOrigin) ||
      allowedOrigins.some((allowed) => cleanOrigin.endsWith(allowed.replace(/^https?:\/\//, '')))
    ) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin ${origin} tidak diizinkan oleh kebijakan keamanan.`));
  },
  credentials: true,
};

app.use(securityHeaders);
app.use(cors(corsOptions));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  fallthrough: false,
  immutable: true,
  maxAge: '7d',
}));
// Batasi ukuran body: dashboard hanya mengirim JSON kecil (form login, pengaturan). 1 MB
// sudah longgar, sekaligus menutup upaya menghabiskan memori lewat payload raksasa.
app.use(express.json({ limit: '1mb' }));

// Rate limit khusus endpoint auth — pertahanan brute-force. 20 percobaan / 15 menit / IP
// cukup untuk pemakaian sah (salah ketik sandi), tapi mematikan untuk penebakan otomatis.
// Bisa disetel lewat AUTH_RATE_LIMIT_MAX bila perlu.
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  message: 'Terlalu banyak percobaan autentikasi. Coba lagi dalam beberapa menit.',
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/shopee', shopeeRoutes);
app.use('/api/warehouse', warehouseRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/optimization', optimizationRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/growth-intelligence', growthIntelligenceRoutes);
app.use('/api/tasks', taskRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Shopee & Warehouse Analytics API',
    timestamp: new Date().toISOString(),
  });
});

// Unmatched API routes: answer explicitly rather than falling through to Express's
// HTML default, which the frontend's response.json() cannot parse.
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Endpoint tidak ditemukan: ${req.method} ${req.originalUrl}`,
  });
});

// Error pipeline. Controllers are wrapped with asyncHandler (src/utils/asyncHandler.js),
// so a rejected async handler lands here instead of leaving the request hanging until
// the client times out. Must stay last, and must keep all four arguments — Express
// identifies error middleware by arity.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[API Error] ${req.method} ${req.originalUrl}:`, err);

  if (res.headersSent) return next(err);

  const status = Number(err.status || err.statusCode) || 500;
  return res.status(status).json({
    success: false,
    error: err.expose && err.message ? err.message : 'Terjadi kesalahan pada server.',
  });
});

async function initApp() {
  try {
    console.log('Initializing system configuration from database...');
    const config = await configService.getAll();

    console.log('System configuration loaded:');
    console.log(`   - Store Name: ${config.storeName || '(Not set)'}`);
    console.log(`   - Cookie Configured: ${config.cookieString ? 'YES' : 'NO'}`);
    console.log(`   - Gemini API Key Configured: ${config.geminiApiKey ? 'YES' : 'NO'}`);
    console.log(`   - Cron Interval: ${config.cronInterval}`);
    console.log(`   - Warehouse Login Configured: ${config.warehouseLoginUrl && config.warehouseInventoryUrl && config.warehouseUsername && config.warehousePassword ? 'YES' : 'NO'}`);

    aiService.setApiKey(config.geminiApiKey);
    shopeeService.setCookie(config.cookieString);
    warehouseService.setWarehouseConfig({
      loginUrl: config.warehouseLoginUrl,
      inventoryUrl: config.warehouseInventoryUrl,
      username: config.warehouseUsername,
      password: config.warehousePassword,
      loginFrom: config.warehouseLoginFrom,
    });

    initCronJobs(config.cronInterval);
  } catch (err) {
    console.error('Failed to load configuration from database on startup:', err.message);
    initCronJobs();
  }
}

initApp().then(() => {
  app.listen(PORT, () => {
    console.log(`Analytics Backend Server running on http://localhost:${PORT}`);
  });
});
