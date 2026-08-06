const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAnalyticsController = require('../controllers/adminAnalyticsController');
const notificationController = require('../controllers/notificationController');
const { authMiddleware, requireAdmin } = require('../middleware/authMiddleware');

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
router.post('/notifications/send', notificationController.sendNotification);
router.post('/notifications/test', notificationController.sendTest);

// System Activity & Health Stats
router.get('/stores', adminController.getAdminStores);
router.get('/audit-logs', adminController.getAuditLogs);
router.get('/system-stats', adminController.getSystemStats);

module.exports = router;
