const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getStatus, chat, validateAnalysis, analyze } = require('../controllers/hermesAgentController');

const router = express.Router();

router.use(authMiddleware);

router.get('/status', getStatus);
router.post('/chat', chat);
router.post('/analyze/validate', validateAnalysis);
router.post('/analyze', analyze);

module.exports = router;
