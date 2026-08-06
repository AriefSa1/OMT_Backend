const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { wrapHandlers } = require('../utils/asyncHandler');

/**
 * Ringkasan akun untuk SEMUA pengguna (bukan hanya admin): profil diri + daftar toko
 * miliknya beserta statistik ringkas per toko. Sengaja ringan — hanya angka yang bisa
 * diambil murah (jumlah produk lewat groupBy, satu baris omzet terakhir per toko) — supaya
 * halaman akun terbuka cepat tanpa menjalankan pipeline analitik penuh.
 *
 * GET /api/account/overview
 */
async function getAccountOverview(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Tidak terautentikasi.' });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, createdAt: true, updatedAt: true }
  });
  if (!user) {
    return res.status(404).json({ success: false, error: 'Akun tidak ditemukan.' });
  }

  const sessions = await prisma.storeSession.findMany({
    where: { userId },
    select: { id: true, storeName: true, storeId: true, isActive: true, lastSyncedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });
  const storeIds = sessions.map((s) => s.storeId);

  // Jumlah produk per toko — satu query groupBy untuk semua toko sekaligus.
  const productCounts = storeIds.length
    ? await prisma.shopeeProduct.groupBy({
        by: ['storeId'],
        where: { storeId: { in: storeIds } },
        _count: { shopeeItemId: true }
      })
    : [];
  const productByStore = new Map(productCounts.map((r) => [r.storeId, r._count.shopeeItemId]));

  // Omzet & order terakhir per toko: ambil semua baris ringkasan untuk toko-toko ini,
  // urut tanggal menurun, lalu simpan baris pertama yang ditemui per toko (= paling baru).
  const latestByStore = new Map();
  if (storeIds.length) {
    const summaries = await prisma.shopeeOrderSummary.findMany({
      where: { storeId: { in: storeIds } },
      select: { storeId: true, date: true, gmv: true, orderCount: true },
      orderBy: { date: 'desc' }
    });
    for (const row of summaries) {
      if (!latestByStore.has(row.storeId)) latestByStore.set(row.storeId, row);
    }
  }

  const stores = sessions.map((s) => {
    const latest = latestByStore.get(s.storeId) || null;
    return {
      id: s.id,
      storeId: s.storeId,
      storeName: s.storeName,
      isActive: s.isActive,
      lastSyncAt: s.lastSyncedAt,
      createdAt: s.createdAt,
      totalProducts: productByStore.get(s.storeId) || 0,
      latestSalesDate: latest?.date || null,
      latestGmv: latest?.gmv ?? null,
      latestOrders: latest?.orderCount ?? null
    };
  });

  return res.json({
    success: true,
    data: {
      user,
      stores,
      summary: {
        totalStores: stores.length,
        activeStores: stores.filter((s) => s.isActive).length,
        totalProducts: stores.reduce((sum, s) => sum + s.totalProducts, 0)
      }
    }
  });
}

/**
 * Ganti sandi diri sendiri. Wajib memasukkan sandi lama — ini mencegah token yang dicuri
 * dipakai mengunci akun dengan mengganti sandi tanpa tahu sandi aslinya. Reset paksa tanpa
 * sandi lama adalah wewenang admin (ada di adminController.resetUserPassword), bukan di sini.
 *
 * PUT /api/account/password
 */
async function changePassword(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Tidak terautentikasi.' });
  }

  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Sandi lama dan sandi baru wajib diisi.' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ success: false, error: 'Sandi baru minimal 6 karakter.' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ success: false, error: 'Sandi baru harus berbeda dari sandi lama.' });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, password: true } });
  if (!user) {
    return res.status(404).json({ success: false, error: 'Akun tidak ditemukan.' });
  }

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) {
    return res.status(401).json({ success: false, error: 'Sandi lama salah.' });
  }

  const hashed = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: userId }, data: { password: hashed } });

  return res.json({ success: true, message: 'Sandi berhasil diperbarui.' });
}

module.exports = wrapHandlers({ getAccountOverview, changePassword });
