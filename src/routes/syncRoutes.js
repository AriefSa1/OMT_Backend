const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getSyncLogs, runFullSync } = require('../controllers/syncController');
const { getJobs, getJob, runAsync } = require('../controllers/syncQueueController');

const router = express.Router();

// Existing routes (blocking sync — kept for backward compatibility)
router.get('/logs', authMiddleware, getSyncLogs);
router.post('/run', authMiddleware, runFullSync);

// New async queue routes
// POST /api/sync/run-async — enqueue a job and return immediately
router.post('/run-async', authMiddleware, runAsync);
// GET /api/sync/jobs — list recent jobs
router.get('/jobs', authMiddleware, getJobs);
// GET /api/sync/jobs/:id — get job status
router.get('/jobs/:id', authMiddleware, getJob);

module.exports = router;
