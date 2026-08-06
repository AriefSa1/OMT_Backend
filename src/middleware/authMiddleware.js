const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

const { getJwtSecret } = require('../utils/jwt');

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
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

