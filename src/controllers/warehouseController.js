const snapshotService = require('../services/snapshotService');
const syncService = require('../services/syncService');

async function getInventory(req, res) {
  try {
    const snapshot = await snapshotService.getWarehouseSnapshot(req.query);
    return res.json({
      success: true,
      items: snapshot.items,
      totalSkus: snapshot.totals.skus,
      totalPhysicalUnits: snapshot.totals.totalPhysicalUnits,
      totalAvailableUnits: snapshot.totals.totalAvailableUnits,
      totals: snapshot.totals,
      pagination: snapshot.pagination,
      meta: snapshot.meta,
      dataSource: snapshot.meta.source,
      message: snapshot.meta.message,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Snapshot gudang tidak dapat dimuat.' });
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

module.exports = { getInventory, getReconciliation, triggerWarehouseSync };
