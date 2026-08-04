const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getGrowthOverview } = require('../controllers/growthIntelligenceController');

const router = express.Router();

router.use(authMiddleware);
router.get('/overview', getGrowthOverview);

module.exports = router;
