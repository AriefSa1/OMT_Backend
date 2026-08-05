const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  getInventory,
  getProductDetail,
  getProductHistory,
  getReconciliation,
  getTeamOverview,
  triggerWarehouseSync,
} = require('../controllers/warehouseController');

const router = express.Router();

router.use(authMiddleware);

router.get('/team-overview', getTeamOverview);
router.get('/inventory', getInventory);
router.get('/inventory/:sku', getProductDetail);
router.get('/inventory/:sku/history', getProductHistory);
router.get('/reconciliation', getReconciliation);
router.post('/sync', triggerWarehouseSync);

module.exports = router;
