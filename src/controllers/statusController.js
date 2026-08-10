const configService = require('../services/configService');
const shopeeService = require('../services/shopeeService');
const warehouseService = require('../services/warehouseService');
const prisma = require('../utils/prisma');
const snapshotService = require('../services/snapshotService');
const { wrapHandlers } = require('../utils/asyncHandler');

// Tiga status seragam: 'connected' (Terhubung), 'disconnected' (Belum terhubung),
// 'error' (Gagal menghubungkan). Dibangun dari PROBE NYATA, bukan kesegaran snapshot —
// supaya "Terhubung" mencerminkan kemampuan mengirim request, bukan kapan terakhir sync.

async function probeShopee() {
  const session = await shopeeService.getActiveSession();
  if (!session?.cookieString) {
    return { status: 'disconnected', label: 'Belum terhubung', detail: 'Belum ada toko / cookie Shopee.' };
  }
  try {
    const r = await shopeeService.fetchOrderSummaryRealtime({ storeId: session.storeId });
    if (r?.source === 'SHOPEE_API') {
      return { status: 'connected', label: 'Terhubung', detail: session.storeName || 'Toko Shopee' };
    }
    return { status: 'error', label: 'Gagal menghubungkan', detail: r?.message || 'Seller Center menolak sesi — cookie mungkin kedaluwarsa.' };
  } catch (err) {
    return { status: 'error', label: 'Gagal menghubungkan', detail: err.message };
  }
}

async function probeWarehouse() {
  if (!warehouseService.isLoginConfigured()) {
    await warehouseService.ensureConfigLoaded().catch(() => {});
  }
  if (!warehouseService.isLoginConfigured()) {
    return { status: 'disconnected', label: 'Belum terhubung', detail: 'Kredensial PDC Gudang belum diisi.' };
  }
  try {
    await warehouseService.getAccessToken(); // login (token di-cache 15 mnt → murah)
    return { status: 'connected', label: 'Terhubung', detail: 'PDC Gudang' };
  } catch (err) {
    return { status: 'error', label: 'Gagal menghubungkan', detail: err.message };
  }
}

async function probeAi(config) {
  const hasKey = Boolean(
    config.geminiApiKey || config.openrouterApiKey
    || process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY,
  );
  if (!hasKey) {
    return { status: 'disconnected', label: 'Belum terhubung', detail: 'API key AI (Gemini/OpenRouter) belum diisi.' };
  }
  const provider = (config.geminiApiKey || process.env.GEMINI_API_KEY) ? 'Gemini' : 'OpenRouter';
  return { status: 'connected', label: 'Terhubung', detail: provider };
}

async function getConnections(req, res) {
  try {
    const config = await configService.getAll();
    const [shopee, warehouse, ai] = await Promise.all([
      probeShopee().catch((e) => ({ status: 'error', label: 'Gagal menghubungkan', detail: e.message })),
      probeWarehouse().catch((e) => ({ status: 'error', label: 'Gagal menghubungkan', detail: e.message })),
      probeAi(config).catch((e) => ({ status: 'error', label: 'Gagal menghubungkan', detail: e.message })),
    ]);
    return res.json({ success: true, shopee, warehouse, ai, checkedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Gagal memeriksa status koneksi.' });
  }
}

async function getStatus(req, res) {
  try {
    const [config, session, latestSync, catalog, ads, warehouse] = await Promise.all([
      configService.getAll(),
      shopeeService.getActiveSession(),
      prisma.syncJobLog.findFirst({ orderBy: { timestamp: 'desc' } }),
      snapshotService.getCatalogSnapshot({ page: 1, limit: 1 }),
      snapshotService.getAdsSnapshot(),
      snapshotService.getWarehouseSnapshot({ page: 1, limit: 1 }),
    ]);

    return res.json({
      success: true,
      connections: {
        shopee: {
          status: session?.isActive ? 'CONFIGURED' : 'DISCONNECTED',
          storeName: session?.storeName || '',
          lastSyncedAt: session?.lastSyncedAt || null,
        },
        gemini: { status: config.geminiApiKey ? 'CONFIGURED' : 'NOT_CONFIGURED' },
        warehouse: {
          status: config.warehouseLoginUrl && config.warehouseInventoryUrl && config.warehouseUsername && config.warehousePassword
            ? 'CONFIGURED'
            : 'BASELINE',
        },
      },
      snapshots: {
        shopee: catalog.meta,
        ads: ads.meta,
        warehouse: warehouse.meta,
      },
      latestSync,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Unable to load connection status' });
  }
}

module.exports = wrapHandlers({ getStatus, getConnections });
