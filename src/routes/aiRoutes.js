const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { generateTitle, generateStoreCopy, generateAds } = require('../controllers/aiController');

const router = express.Router();

router.use(authMiddleware);

router.post('/generate-title', generateTitle);
router.post('/generate-store-copy', generateStoreCopy);
router.post('/generate-ads-keywords', generateAds);

module.exports = router;
