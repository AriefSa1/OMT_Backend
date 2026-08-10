const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

const { getJwtSecret } = require('../utils/jwt');

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // Dev-only bypass: request tanpa token dianggap admin default. DIKUNCI GANDA —
      // hanya aktif bila BUKAN produksi DAN flag DEV_AUTH_BYPASS=1 diset eksplisit.
      // Di produksi (Render, NODE_ENV=production) ini MUSTAHIL aktif meski flag terlanjur diset.
      const devBypass = process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === '1';
      if (devBypass) {
        const defaultUser = await prisma.user.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { id: true, email: true, name: true, role: true, createdAt: true }
        });
        if (defaultUser) {
          req.user = defaultUser;
          return next();
        }
      }
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing or invalid authorization token format'
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Token value missing'
      });
    }

    const decoded = jwt.verify(token, getJwtSecret());

    // A valid token must resolve to an existing account; deleted users lose access.
    const userId = decoded.userId || decoded.id;
    let user = null;

    if (userId) {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, role: true, createdAt: true }
      });
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: User account no longer exists'
      });
    }

    req.user = user;
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Token has expired'
      });
    }
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid token signature'
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: 'Akses ditolak: Hanya administrator yang dapat mengakses fungsi ini.'
    });
  }
  return next();
}

function requireRoles(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Akses ditolak: Memerlukan peran ${allowedRoles.join(' atau ')}.`
      });
    }
    return next();
  };
}

authMiddleware.authMiddleware = authMiddleware;
authMiddleware.requireAdmin = requireAdmin;
authMiddleware.requireRoles = requireRoles;

module.exports = authMiddleware;

