const express = require('express');
const router = express.Router();
const accountController = require('../controllers/accountController');
const authMiddleware = require('../middleware/authMiddleware');

// Semua rute akun butuh login. Tidak butuh peran khusus — setiap pengguna mengelola
// akunnya sendiri; identitas diambil dari token (req.user), bukan dari parameter.
router.use(authMiddleware);

router.get('/overview', accountController.getAccountOverview);
router.put('/password', accountController.changePassword);

module.exports = router;
