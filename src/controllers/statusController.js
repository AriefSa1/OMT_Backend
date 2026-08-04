const configService = require('../services/configService');
const shopeeService = require('../services/shopeeService');
const prisma = require('../utils/prisma');
const snapshotService = require('../services/snapshotService');
const { wrapHandlers } = require('../utils/asyncHandler');

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

module.exports = wrapHandlers({ getStatus });
