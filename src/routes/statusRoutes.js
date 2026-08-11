const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getStatus, getConnections } = require('../controllers/statusController');

const router = express.Router();
router.get('/', authMiddleware, getStatus);
router.get('/connections', authMiddleware, getConnections);

module.exports = router;
