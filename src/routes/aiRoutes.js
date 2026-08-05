const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  generateABCopy,
  predictRestock,
  simulatePricing,
  getDailyBriefing,
  optimizeAdsKeywords,
  suggestScaleUp,
} = require('../controllers/aiController');

const router = express.Router();

router.use(authMiddleware);

router.post('/ab-copy', generateABCopy);
router.post('/predictive-restock', predictRestock);
router.post('/pricing-simulator', simulatePricing);
router.get('/daily-briefing', getDailyBriefing);
router.post('/daily-briefing', getDailyBriefing);
router.post('/ads-keyword-optimization', optimizeAdsKeywords);
router.post('/scale-up-strategy', suggestScaleUp);

module.exports = router;
