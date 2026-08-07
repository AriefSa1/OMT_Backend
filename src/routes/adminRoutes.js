const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAnalyticsController = require('../controllers/adminAnalyticsController');
const notificationController = require('../controllers/notificationController');
const { authMiddleware, requireAdmin } = require('../middleware/authMiddleware');

const uploadDir = path.resolve(__dirname, '../../uploads/notifications');
fs.mkdirSync(uploadDir, { recursive: true });

const safeBasename = (name) => path.basename(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${safeBasename(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// Semua rute admin diproteksi token otentikasi & validasi peran ADMIN
router.use(authMiddleware);
router.use(requireAdmin);

// User Management
router.get('/users', adminController.getUsers);
router.post('/users', adminController.createUser);
router.put('/users/:id/role', adminController.updateUserRole);
router.put('/users/:id/reset-password', adminController.resetUserPassword);
router.delete('/users/:id', adminController.deleteUser);

// Registration & Invite Codes
router.get('/registration-codes', adminController.getRegistrationCodes);
router.post('/registration-codes', adminController.createRegistrationCode);
router.patch('/registration-codes/:id/toggle', adminController.toggleRegistrationCode);
router.delete('/registration-codes/:id', adminController.deleteRegistrationCode);

// Store Analytics (pembanding lintas toko/user)
router.get('/stores/stats', adminAnalyticsController.getStoresStats);
router.get('/analytics/compare', adminAnalyticsController.compareStores);
router.get('/analytics/weekly', adminAnalyticsController.getWeeklyPerformance);
router.get('/analytics/weekly/declining.csv', adminAnalyticsController.downloadDecliningCsv);

// Notifikasi (Discord/Telegram; WhatsApp menyusul)
router.get('/notifications/channels', notificationController.getChannels);
router.get('/notifications/logs', notificationController.getLogs);
router.get('/notifications/config/:userId', notificationController.getUserConfig);
router.put('/notifications/config/:userId', notificationController.updateUserConfig);
router.post('/notifications/upload', upload.single('file'), notificationController.handleFileUpload);
router.post('/notifications/send', notificationController.sendNotification);
router.post('/notifications/test', notificationController.sendTest);

// System Activity & Health Stats
router.get('/stores', adminController.getAdminStores);
router.get('/audit-logs', adminController.getAuditLogs);
router.get('/system-stats', adminController.getSystemStats);

module.exports = router;
