const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { wrapHandlers } = require('../utils/asyncHandler');

const { getJwtSecret } = require('../utils/jwt');

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    getJwtSecret(),
    { expiresIn: '24h' }
  );
}

/**
 * Register a new user
 * POST /api/auth/register
 */
async function register(req, res) {
  try {
    const { name, email, password } = req.body;
    const providedSecret = String(
      req.headers['x-registration-secret'] ||
      req.body?.registrationSecret ||
      req.body?.code ||
      ''
    ).trim();

    const userCount = await prisma.user.count();
    const isBootstrap = userCount === 0;
    let assignedRole = 'USER';
    let matchedRegistrationCode = null;

    if (isBootstrap) {
      // User pertama otomatis menjadi ADMIN
      assignedRole = 'ADMIN';
    } else {
      if (!providedSecret) {
        return res.status(403).json({
          success: false,
          error: 'Kode undangan/registrasi diperlukan untuk membuat akun. Hubungi administrator.'
        });
      }

      // 1. Cek database tabel RegistrationCode
      const codeRecord = await prisma.registrationCode.findFirst({
        where: {
          code: {
            equals: providedSecret,
            mode: 'insensitive'
          }
        }
      });

      if (codeRecord) {
        if (!codeRecord.isActive) {
          return res.status(403).json({
            success: false,
            error: 'Kode registrasi ini telah dinonaktifkan oleh administrator.'
          });
        }

        if (codeRecord.expiresAt && new Date() > new Date(codeRecord.expiresAt)) {
          return res.status(403).json({
            success: false,
            error: 'Kode registrasi ini telah kedaluwarsa.'
          });
        }

        if (codeRecord.maxUses > 0 && codeRecord.usedCount >= codeRecord.maxUses) {
          return res.status(403).json({
            success: false,
            error: 'Batas kuota penggunaan kode registrasi ini telah habis.'
          });
        }

        matchedRegistrationCode = codeRecord;
        assignedRole = codeRecord.role === 'ADMIN' ? 'ADMIN' : 'USER';
      } else {
        // 2. Fallback ke process.env.REGISTRATION_SECRET jika dikonfigurasi
        const configuredSecret = (process.env.REGISTRATION_SECRET || '').trim();
        if (configuredSecret && providedSecret === configuredSecret) {
          assignedRole = 'USER';
        } else {
          return res.status(403).json({
            success: false,
            error: 'Kode registrasi / undangan tidak valid atau tidak ditemukan.'
          });
        }
      }
    }

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Name, email, and password are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address format' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existingUser) {
      return res.status(400).json({ success: false, error: 'User with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        role: assignedRole
      }
    });

    // Update penggunaan kode registrasi bila menggunakan RegistrationCode dari database
    if (matchedRegistrationCode) {
      const nextUsedCount = matchedRegistrationCode.usedCount + 1;
      const shouldDeactivate = matchedRegistrationCode.maxUses > 0 && nextUsedCount >= matchedRegistrationCode.maxUses;

      await prisma.registrationCode.update({
        where: { id: matchedRegistrationCode.id },
        data: {
          usedCount: nextUsedCount,
          isActive: shouldDeactivate ? false : matchedRegistrationCode.isActive
        }
      }).catch(err => console.error('Failed to update registration code usage:', err));

      // Catat log audit pendaftaran
      await prisma.adminAuditLog.create({
        data: {
          action: 'USER_REGISTERED',
          details: JSON.stringify({
            code: matchedRegistrationCode.code,
            assignedRole,
            remainingUses: matchedRegistrationCode.maxUses > 0 ? matchedRegistrationCode.maxUses - nextUsedCount : 'unlimited'
          }),
          targetId: user.id,
          targetName: `${user.name} (${user.email})`,
          actorId: user.id,
          actorName: user.name,
          actorEmail: user.email,
          ipAddress: req.ip || req.headers['x-forwarded-for'] || 'direct'
        }
      }).catch(err => console.error('Failed to create audit log for registration:', err));
    }

    const token = generateToken(user);

    return res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ success: false, error: 'Failed to register user' });
  }
}

/**
 * Login user with email & password
 * POST /api/auth/login
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = generateToken(user);

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, error: 'Failed to authenticate user' });
  }
}

/**
 * Get current user profile
 * GET /api/auth/me
 */
async function getMe(req, res) {
  try {
    if (!req.user || (!req.user.id && !req.user.userId)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const userId = req.user.id || req.user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    return res.json({
      success: true,
      user
    });
  } catch (err) {
    console.error('GetMe error:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve user profile' });
  }
}

module.exports = wrapHandlers({ register, login, getMe });
