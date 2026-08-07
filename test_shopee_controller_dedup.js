/**
 * Regression test: verifikasi duplikat query di shopeeController sudah dihapus.
 * getAllStores dan getSessionStatus sekarang memakai productCount dari getAllSessions
 * alih-alih mengulangi groupBy.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const controllerSrc = fs.readFileSync(
  path.join(__dirname, 'src/controllers/shopeeController.js'),
  'utf8'
);

// 1. Pastikan duplikat groupBy sudah dihapus dari getAllStores
assert.match(
  controllerSrc,
  /const allSessions = await shopeeService\.getAllSessions\(req\.user\);[\s\S]*?productCount: s\.productCount \|\| 0/,
  'getAllStores seharusnya menggunakan productCount dari getAllSessions, bukan groupBy terpisah'
);

// 2. Pastikan tidak ada lagi prisma.shopeeProduct.groupBy di dalam getAllStores atau getSessionStatus
const getAllStoresMatch = controllerSrc.match(/async function getAllStores[\s\S]*?^}/m);
assert.ok(getAllStoresMatch, 'getAllStores function harus ditemukan');
assert.doesNotMatch(
  getAllStoresMatch[0],
  /prisma\.shopeeProduct\.groupBy/,
  'getAllStores tidak boleh memanggil prisma.shopeaProduct.groupBy lagi'
);

const getSessionStatusMatch = controllerSrc.match(/async function getSessionStatus[\s\S]*?^}/m);
assert.ok(getSessionStatusMatch, 'getSessionStatus function harus ditemukan');
assert.doesNotMatch(
  getSessionStatusMatch[0],
  /prisma\.shopeeProduct\.groupBy/,
  'getSessionStatus tidak boleh memanggil prisma.shopeeProduct.groupBy lagi'
);

// 3. Pastikan getSessionStatus tidak lagi mengaitkan productCounts
const sessionStatusMatch = controllerSrc.match(/async function getSessionStatus[\s\S]*?^}/m);
assert.ok(sessionStatusMatch, 'getSessionStatus function harus ditemukan');
assert.doesNotMatch(
  sessionStatusMatch[0],
  /productCounts/,
  'getSessionStatus tidak boleh lagi memakai variabel productCounts'
);

console.log('shopeeController duplicate query regression checks passed');
