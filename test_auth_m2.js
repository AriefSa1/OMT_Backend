const express = require('express');
const http = require('http');
const prisma = require('./src/utils/prisma');
const authRoutes = require('./src/routes/authRoutes');
const settingsRoutes = require('./src/routes/settingsRoutes');
const shopeeRoutes = require('./src/routes/shopeeRoutes');
const warehouseRoutes = require('./src/routes/warehouseRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');
const axios = require('axios');

async function runVerificationTests() {
  console.log('=== Starting Milestone 2 Auth & Route Protection Verification ===');

  // Setup express test app
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/shopee', shopeeRoutes);
  app.use('/api/warehouse', warehouseRoutes);
  app.use('/api/dashboard', dashboardRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(5099, resolve));
  console.log('Test server listening on port 5099');

  const BASE_URL = 'http://localhost:5099/api';

  let testPassed = 0;
  let testTotal = 0;

  function assert(condition, message) {
    testTotal++;
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      testPassed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
    }
  }

  try {
    // Clean up test user if exists
    const testEmail = `test_m2_${Date.now()}@velvetrose.com`;

    // 1. Test Registration
    console.log('\n--- Test 1: User Registration ---');
    const regRes = await axios.post(`${BASE_URL}/auth/register`, {
      name: 'Test M2 User',
      email: testEmail,
      password: 'securepassword123',
      role: 'ANALYST'
    }, { validateStatus: () => true });

    assert(regRes.status === 201, `Registration returned HTTP 201 (got ${regRes.status})`);
    assert(regRes.data.success === true, 'Registration response success is true');
    assert(typeof regRes.data.token === 'string', 'Registration response includes JWT token');
    assert(regRes.data.user.email === testEmail, 'User email matches registration input');
    assert(regRes.data.user.password === undefined, 'Password field omitted from user response');

    // 2. Test Duplicate Registration Guard
    console.log('\n--- Test 2: Duplicate Registration Guard ---');
    const dupRes = await axios.post(`${BASE_URL}/auth/register`, {
      name: 'Test M2 User',
      email: testEmail,
      password: 'securepassword123'
    }, { validateStatus: () => true });

    assert(dupRes.status === 400, `Duplicate registration returned HTTP 400 (got ${dupRes.status})`);
    assert(dupRes.data.success === false, 'Duplicate registration response success is false');

    // 3. Test User Login
    console.log('\n--- Test 3: User Login ---');
    const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
      email: testEmail,
      password: 'securepassword123'
    }, { validateStatus: () => true });

    assert(loginRes.status === 200, `Login returned HTTP 200 (got ${loginRes.status})`);
    assert(loginRes.data.success === true, 'Login response success is true');
    assert(typeof loginRes.data.token === 'string', 'Login returned valid JWT token');

    const authToken = loginRes.data.token;

    // 4. Test Invalid Password Login
    console.log('\n--- Test 4: Invalid Password Login ---');
    const invalidLoginRes = await axios.post(`${BASE_URL}/auth/login`, {
      email: testEmail,
      password: 'wrongpassword'
    }, { validateStatus: () => true });

    assert(invalidLoginRes.status === 401, `Invalid password login returned HTTP 401 (got ${invalidLoginRes.status})`);
    assert(invalidLoginRes.data.success === false, 'Invalid login response success is false');

    // 5. Test Session Verification (GET /api/auth/me) with Token
    console.log('\n--- Test 5: GET /api/auth/me with Bearer Token ---');
    const meRes = await axios.get(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
      validateStatus: () => true
    });

    assert(meRes.status === 200, `GET /me returned HTTP 200 (got ${meRes.status})`);
    assert(meRes.data.success === true, 'GET /me response success is true');
    assert(meRes.data.user.email === testEmail, 'GET /me returns correct user email');

    // 6. Test Unauthenticated Access Guard on GET /api/auth/me
    console.log('\n--- Test 6: GET /api/auth/me without Token ---');
    const unauthMeRes = await axios.get(`${BASE_URL}/auth/me`, {
      validateStatus: () => true
    });

    assert(unauthMeRes.status === 401, `Unauthenticated GET /me returned HTTP 401 (got ${unauthMeRes.status})`);

    // 7. Test Protected Settings Endpoint (Unauthenticated vs Authenticated)
    console.log('\n--- Test 7: Protected Routes Guard (/api/settings) ---');
    const unauthSettingsRes = await axios.get(`${BASE_URL}/settings`, { validateStatus: () => true });
    assert(unauthSettingsRes.status === 401, `Unauthenticated /settings returned HTTP 401 (got ${unauthSettingsRes.status})`);

    const authSettingsRes = await axios.get(`${BASE_URL}/settings`, {
      headers: { Authorization: `Bearer ${authToken}` },
      validateStatus: () => true
    });
    assert(authSettingsRes.status === 200, `Authenticated /settings returned HTTP 200 (got ${authSettingsRes.status})`);

    // 8. Test Protected Shopee Endpoint
    console.log('\n--- Test 8: Protected Routes Guard (/api/shopee/session) ---');
    const unauthShopeeRes = await axios.get(`${BASE_URL}/shopee/session`, { validateStatus: () => true });
    assert(unauthShopeeRes.status === 401, `Unauthenticated /shopee/session returned HTTP 401 (got ${unauthShopeeRes.status})`);

    const authShopeeRes = await axios.get(`${BASE_URL}/shopee/session`, {
      headers: { Authorization: `Bearer ${authToken}` },
      validateStatus: () => true
    });
    assert(authShopeeRes.status === 200, `Authenticated /shopee/session returned HTTP 200 (got ${authShopeeRes.status})`);

    // 9. Test Demo Admin Auto-Seed Login
    console.log('\n--- Test 9: Demo Admin Login Auto-Seeding ---');
    const demoLoginRes = await axios.post(`${BASE_URL}/auth/login`, {
      email: 'admin@velvetrose.com',
      password: 'password123'
    }, { validateStatus: () => true });

    assert(demoLoginRes.status === 200, `Demo admin login returned HTTP 200 (got ${demoLoginRes.status})`);
    assert(demoLoginRes.data.user.email === 'admin@velvetrose.com', 'Demo admin email is admin@velvetrose.com');

    // Clean up created test user from database
    await prisma.user.deleteMany({ where: { email: testEmail } });

    console.log(`\n=== Verification Complete: ${testPassed}/${testTotal} tests passed ===`);
  } catch (err) {
    console.error('Fatal error during test execution:', err);
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runVerificationTests();
