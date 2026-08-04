const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.get('/', settingsController.getSettings);
router.post('/', settingsController.updateSettings);
router.put('/', settingsController.updateSettings);
router.post('/test-warehouse', settingsController.testWarehouseConnection);

module.exports = router;
