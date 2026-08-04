const snapshotService = require('../services/snapshotService');
const warehouseService = require('../services/warehouseService');
const syncService = require('../services/syncService');
const { wrapHandlers } = require('../utils/asyncHandler');

async function getInventory(req, res) {
  try {
    const snapshot = await snapshotService.getWarehouseSnapshot(req.query);
    return res.json({
      success: true,
      items: snapshot.items,
      totalSkus: snapshot.totals.skus,
      totalPhysicalUnits: snapshot.totals.totalPhysicalUnits,
      totalAvailableUnits: snapshot.totals.totalAvailableUnits,
      totalValuation: snapshot.totals.totalValuation,
      totals: snapshot.totals,
      counts: snapshot.counts,
      filters: snapshot.filters,
      pagination: snapshot.pagination,
      meta: snapshot.meta,
      dataSource: snapshot.meta.source,
      message: snapshot.meta.message,
    });
  } catch (err) {
    console.error('[Warehouse Controller] getInventory error:', err);
    return res.status(500).json({ success: false, error: 'Snapshot gudang tidak dapat dimuat.' });
  }
}

async function getProductDetail(req, res) {
  try {
    const sku = req.params.sku;
    const detail = await warehouseService.getProductDetail(sku, {
      warehouseId: req.query.warehouseId,
      variantId: req.query.variantId,
    });

    if (!detail.found) {
      return res.status(404).json({
        success: false,
        error: detail.message,
        message: detail.message,
      });
    }

    const { found, ...payload } = detail;
    return res.json({
      success: true,
      ...payload,
    });
  } catch (err) {
    console.error('[Warehouse Controller] getProductDetail error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Detail produk tidak dapat dimuat.' });
  }
}

async function getProductHistory(req, res) {
  try {
    const sku = req.params.sku;
    const history = await warehouseService.getProductStockHistory(sku, req.query);
    return res.json({
      success: true,
      ...history,
    });
  } catch (err) {
    console.error('[Warehouse Controller] getProductHistory error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Riwayat stok produk tidak dapat dimuat.' });
  }
}

async function getReconciliation(req, res) {
  try {
    const snapshot = await snapshotService.getWarehouseSnapshot({ page: 1, limit: 100 });
    const reconciliationList = snapshot.reconciliation;
    const discrepanciesCount = reconciliationList.filter((row) => row.status !== 'MATCHED').length;
    return res.json({
      success: true,
      totalAudited: reconciliationList.length,
      matchedCount: reconciliationList.length - discrepanciesCount,
      discrepanciesCount,
      reconciliationList,
      meta: snapshot.meta,
      dataSource: snapshot.meta.source,
      message: snapshot.meta.message,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Snapshot rekonsiliasi tidak dapat dimuat.' });
  }
}

async function triggerWarehouseSync(req, res) {
  const result = await syncService.syncWarehouse({ origin: 'MANUAL' });
  return res.status(result.success ? 200 : 502).json(result);
}

module.exports = wrapHandlers({
  getInventory,
  getProductDetail,
  getProductHistory,
  getReconciliation,
  triggerWarehouseSync,
});
