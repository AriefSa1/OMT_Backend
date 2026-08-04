require('dotenv').config();
const express = require('express');
const cors = require('cors');

const configService = require('./src/services/configService');
const aiService = require('./src/services/aiService');
const shopeeService = require('./src/services/shopeeService');
const warehouseService = require('./src/services/warehouseService');
const { initCronJobs } = require('./src/cron/syncCron');

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

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use('/api/auth', authRoutes);
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
