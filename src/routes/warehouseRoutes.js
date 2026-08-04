const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  getInventory,
  getReconciliation,
  triggerWarehouseSync
} = require('../controllers/warehouseController');

const router = express.Router();

router.use(authMiddleware);

router.get('/inventory', getInventory);
router.get('/reconciliation', getReconciliation);
router.post('/sync', triggerWarehouseSync);

module.exports = router;
