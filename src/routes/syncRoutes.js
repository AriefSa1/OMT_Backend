const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getSyncLogs, runFullSync } = require('../controllers/syncController');

const router = express.Router();
router.get('/logs', authMiddleware, getSyncLogs);
router.post('/run', authMiddleware, runFullSync);

module.exports = router;
