const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getStatus } = require('../controllers/statusController');

const router = express.Router();
router.get('/', authMiddleware, getStatus);

module.exports = router;
