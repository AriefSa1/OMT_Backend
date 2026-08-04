const express = require('express');
const http = require('http');
const axios = require('axios');
const cors = require('cors');

const authRoutes = require('./src/routes/authRoutes');
const settingsRoutes = require('./src/routes/settingsRoutes');
const statusRoutes = require('./src/routes/statusRoutes');
const shopeeRoutes = require('./src/routes/shopeeRoutes');
const warehouseRoutes = require('./src/routes/warehouseRoutes');
const syncRoutes = require('./src/routes/syncRoutes');
const aiRoutes = require('./src/routes/aiRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');

const authMiddleware = require('./src/middleware/authMiddleware');
const prisma = require('./src/utils/prisma');

async function runE2E() {
  console.log('=== Starting Complete End-to-End System Audit ===\n');

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Public
  app.use('/api/auth', authRoutes);

  // Protected
  app.use('/api/settings', authMiddleware, settingsRoutes);
  app.use('/api/status', authMiddleware, statusRoutes);
  app.use('/api/shopee', authMiddleware, shopeeRoutes);
  app.use('/api/warehouse', authMiddleware, warehouseRoutes);
  app.use('/api/sync', authMiddleware, syncRoutes);
  app.use('/api/ai', authMiddleware, aiRoutes);
  app.use('/api/dashboard', authMiddleware, dashboardRoutes);

  const server = http.createServer(app);
  const TEST_PORT = 5098;

  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`Test server listening on port ${TEST_PORT}\n`);

  const client = axios.create({
    baseURL: `http://localhost:${TEST_PORT}`,
    validateStatus: () => true,
  });

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`✅ PASS: ${message}`);
    } else {
      console.error(`❌ FAIL: ${message}`);
    }
  }

  try {
    // 1. Authentication flow
    console.log('--- Suite 1: Authentication & Authorization ---');
    const testEmail = `test_e2e_${Date.now()}@example.com`;
    const regRes = await client.post('/api/auth/register', {
      name: 'E2E Test User',
      email: testEmail,
      password: 'password123',
    });
    assert(regRes.status === 201, `Registration status 201 (got ${regRes.status})`);
    assert(Boolean(regRes.data.token), 'Registration returns JWT token');

    const authToken = regRes.data.token;
    const authHeaders = { Authorization: `Bearer ${authToken}` };

    const meRes = await client.get('/api/auth/me', { headers: authHeaders });
    assert(meRes.status === 200, `GET /api/auth/me status 200 (got ${meRes.status})`);
    assert(meRes.data.user.email === testEmail, 'User profile returned correctly');

    // 2. Settings persistence
    console.log('\n--- Suite 2: Settings Persistence & AppConfig ---');
    const setRes = await client.post(
      '/api/settings',
      {
        storeName: 'E2E Audit Store',
        cronInterval: '30m',
        warehouseInventoryUrl: 'https://warehouse.test/api/stock',
      },
      { headers: authHeaders }
    );
    assert(setRes.status === 200, `POST /api/settings status 200 (got ${setRes.status})`);
    assert(setRes.data.settings.storeName === 'E2E Audit Store', 'Store name saved and returned');
    assert(setRes.data.settings.cronInterval === '30m', 'Cron interval saved as 30m');

    const getSetRes = await client.get('/api/settings', { headers: authHeaders });
    assert(getSetRes.status === 200, `GET /api/settings status 200 (got ${getSetRes.status})`);
    assert(getSetRes.data.settings.storeName === 'E2E Audit Store', 'Saved settings read back correctly');

    // 3. System Status
    console.log('\n--- Suite 3: System Status & Diagnostic Indicators ---');
    const statusRes = await client.get('/api/status', { headers: authHeaders });
    assert(statusRes.status === 200, `GET /api/status status 200 (got ${statusRes.status})`);
    assert(statusRes.data.success === true, 'Status response indicates success');
    assert(typeof statusRes.data.snapshots === 'object', 'Snapshot diagnostics provided');

    // 4. Shopee Endpoints & Graceful Empty States
    console.log('\n--- Suite 4: Shopee Catalog, Ads & Session Endpoints ---');
    const catalogRes = await client.get('/api/shopee/metrics', { headers: authHeaders });
    assert(catalogRes.status === 200, `GET /api/shopee/metrics status 200 (got ${catalogRes.status})`);
    assert(Array.isArray(catalogRes.data.products), 'Products array returned');

    const adsRes = await client.get('/api/shopee/ads', { headers: authHeaders });
    assert(adsRes.status === 200, `GET /api/shopee/ads status 200 (got ${adsRes.status})`);
    assert(adsRes.data.success === true, 'Ads response returned');

    const sessionRes = await client.get('/api/shopee/session', { headers: authHeaders });
    assert(sessionRes.status === 200, `GET /api/shopee/session status 200 (got ${sessionRes.status})`);

    // Shopee Product Performance with all period filters
    for (const period of ['real_time', 'yesterday', 'past7days', 'past30days']) {
      const perfRes = await client.get(`/api/shopee/product-performance?period=${period}`, { headers: authHeaders });
      assert(perfRes.status === 200, `GET /api/shopee/product-performance?period=${period} status 200 (got ${perfRes.status})`);
      assert(perfRes.data.success === true, `Performance response for ${period} succeeds`);
      assert(perfRes.data.period === period, `Performance response period matches ${period}`);
      assert(typeof perfRes.data.summary === 'object', `Summary metrics object present for ${period}`);
      assert(Array.isArray(perfRes.data.products), `Products array present for ${period}`);
    }

    // 5. Warehouse & Reconciliation
    console.log('\n--- Suite 5: Warehouse Inventory & Stock Reconciliation ---');
    const warehouseRes = await client.get('/api/warehouse/inventory', { headers: authHeaders });
    assert(warehouseRes.status === 200, `GET /api/warehouse/inventory status 200 (got ${warehouseRes.status})`);
    assert(Array.isArray(warehouseRes.data.items), 'Warehouse items array returned');

    const reconRes = await client.get('/api/warehouse/reconciliation', { headers: authHeaders });
    assert(reconRes.status === 200, `GET /api/warehouse/reconciliation status 200 (got ${reconRes.status})`);
    assert(Array.isArray(reconRes.data.reconciliationList), 'Reconciliations array returned');

    // 6. Sync Logs
    console.log('\n--- Suite 6: Sync Job Logs ---');
    const logsRes = await client.get('/api/sync/logs', { headers: authHeaders });
    assert(logsRes.status === 200, `GET /api/sync/logs status 200 (got ${logsRes.status})`);
    assert(Array.isArray(logsRes.data.logs), 'Sync logs array returned');

    // 7. AI Endpoints Graceful Fallback / Status
    console.log('\n--- Suite 7: Gemini AI Optimization Endpoints ---');
    const aiTitleRes = await client.post(
      '/api/ai/generate-title',
      { productName: 'Gamis Casual Polos Syari' },
      { headers: authHeaders }
    );
    assert(aiTitleRes.status === 200, `POST /api/ai/generate-title status 200 (got ${aiTitleRes.status})`);
    assert(
      aiTitleRes.data.provider === 'REAL_GEMINI_API' || aiTitleRes.data.provider === 'NOT_CONFIGURED',
      `AI Provider status reported properly (got ${aiTitleRes.data.provider})`
    );

    const aiCopyRes = await client.post(
      '/api/ai/generate-store-copy',
      { storeName: 'E2E Audit Store' },
      { headers: authHeaders }
    );
    assert(aiCopyRes.status === 200, `POST /api/ai/generate-store-copy status 200 (got ${aiCopyRes.status})`);

    const aiAdsRes = await client.post(
      '/api/ai/generate-ads-keywords',
      { campaignName: 'Gamis Promotion' },
      { headers: authHeaders }
    );
    assert(aiAdsRes.status === 200, `POST /api/ai/generate-ads-keywords status 200 (got ${aiAdsRes.status})`);

    // 8. Dashboard Overview Aggregation
    console.log('\n--- Suite 8: Dashboard Overview Aggregation ---');
    const dashRes = await client.get('/api/dashboard/overview', { headers: authHeaders });
    assert(dashRes.status === 200, `GET /api/dashboard/overview status 200 (got ${dashRes.status})`);
    assert(typeof dashRes.data.data.kpis === 'object', 'Dashboard KPIs structure provided');
    assert(Array.isArray(dashRes.data.data.salesTrend), 'Sales trend array provided');

    // 9. Unauthorized access rejection
    console.log('\n--- Suite 9: Unauthorized Route Protection Guard ---');
    const unauthDashRes = await client.get('/api/dashboard/overview');
    assert(unauthDashRes.status === 401, `Unauthenticated request blocked with 401 (got ${unauthDashRes.status})`);

    const unauthSettingsRes = await client.get('/api/settings');
    assert(unauthSettingsRes.status === 401, `Unauthenticated settings blocked with 401 (got ${unauthSettingsRes.status})`);

  } finally {
    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n=== E2E System Audit Complete: ${passedTests}/${totalTests} tests passed ===`);
  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runE2E().catch((err) => {
  console.error('Fatal E2E Error:', err);
  process.exit(1);
});
