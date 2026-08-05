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

    // Kontrol akses registrasi. Aplikasi ini terdeploy publik di 94media.art dan datanya
    // adalah angka penjualan/gudang nyata satu toko — registrasi terbuka berarti siapa pun
    // yang menemukan URL-nya bisa membuat akun dan melihat semuanya. Aturannya:
    //
    // - Bila belum ada user sama sekali (deploy baru), izinkan satu pendaftaran pertama
    //   sebagai bootstrap admin, tanpa kode. Ini menghindari masalah "ayam dan telur".
    // - Selain itu, wajib kode undangan yang cocok dengan REGISTRATION_SECRET (dikirim
    //   lewat header x-registration-secret atau field registrationSecret).
    // - Bila REGISTRATION_SECRET tidak diset dan sudah ada user, registrasi ditutup total;
    //   tambah user lewat manage_admin.js. Gagal-tertutup, bukan gagal-terbuka.
    const userCount = await prisma.user.count();
    const isBootstrap = userCount === 0;
    if (!isBootstrap) {
      const configuredSecret = (process.env.REGISTRATION_SECRET || '').trim();
      const providedSecret = String(req.headers['x-registration-secret'] || req.body?.registrationSecret || '').trim();
      if (!configuredSecret) {
        return res.status(403).json({ success: false, error: 'Pendaftaran mandiri dinonaktifkan. Hubungi administrator.' });
      }
      if (providedSecret !== configuredSecret) {
        return res.status(403).json({ success: false, error: 'Kode undangan tidak valid.' });
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
        // User pertama (bootstrap) menjadi ADMIN supaya selalu ada pemilik; sisanya ANALYST.
        role: isBootstrap ? 'ADMIN' : 'ANALYST'
      }
    });

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
