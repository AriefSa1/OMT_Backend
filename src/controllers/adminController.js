const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { wrapHandlers } = require('../utils/asyncHandler');

/**
 * Generate a clean, readable registration code
 * e.g., REG-8K9X-2026 or INV-FASHION-77
 */
function generateReadableCode(prefix = 'REG') {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let randomPart = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) {
    randomPart += chars[bytes[i] % chars.length];
  }
  const year = new Date().getFullYear();
  return `${prefix}-${randomPart}-${year}`;
}

/**
 * Helper to record administrative audit trail
 */
async function logAdminAction({ action, details, targetId, targetName, req }) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        action,
        details: typeof details === 'object' ? JSON.stringify(details) : details,
        targetId: targetId ? String(targetId) : null,
        targetName: targetName ? String(targetName) : null,
        actorId: req?.user?.id ? String(req.user.id) : null,
        actorName: req?.user?.name || 'Administrator',
        actorEmail: req?.user?.email || 'admin',
        ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || 'direct'
      }
    });
  } catch (err) {
    console.error('[AdminAuditLog] Failed to record audit log:', err.message);
  }
}

/**
 * GET /api/admin/users
 * List all users with filtering, search, and role breakdown
 */
async function getUsers(req, res) {
  try {
    const { search = '', role = '', page = 1, limit = 100 } = req.query;

    const where = {};
    if (role && ['ADMIN', 'USER'].includes(role.toUpperCase())) {
      where.role = role.toUpperCase();
    }

    if (search.trim()) {
      const q = search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } }
      ];
    }

    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max((Number(page) || 1) - 1, 0) * take;

    const [users, total, roleCounts] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          updatedAt: true,
          stores: {
            select: {
              id: true,
              storeName: true,
              storeId: true,
              isActive: true,
              lastSyncedAt: true,
            }
          },
          _count: {
            select: { stores: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip
      }),
      prisma.user.count({ where }),
      prisma.user.groupBy({
        by: ['role'],
        _count: { _all: true }
      })
    ]);

    const counts = {
      TOTAL: 0,
      ADMIN: 0,
      USER: 0,
    };

    roleCounts.forEach((r) => {
      const key = r.role === 'ADMIN' ? 'ADMIN' : 'USER';
      counts[key] = (counts[key] || 0) + r._count._all;
      counts.TOTAL += r._count._all;
    });

    return res.json({
      success: true,
      data: {
        users,
        total,
        page: Number(page) || 1,
        limit: take,
        counts,
        currentUserId: req.user.id
      }
    });
  } catch (err) {
    console.error('[adminController] getUsers error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengambil daftar pengguna' });
  }
}

/**
 * POST /api/admin/users
 * Direct creation of user by admin
 */
async function createUser(req, res) {
  try {
    const { name, email, password, role = 'USER' } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Nama, email, dan password wajib diisi.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Format alamat email tidak valid.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password minimal 6 karakter.' });
    }

    const validRoles = ['ADMIN', 'USER'];
    const targetRole = validRoles.includes(String(role).toUpperCase()) ? String(role).toUpperCase() : 'USER';

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Pengguna dengan email ini sudah terdaftar.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        role: targetRole
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true
      }
    });

    await logAdminAction({
      action: 'USER_CREATED',
      details: { role: targetRole, createdDirectly: true },
      targetId: user.id,
      targetName: `${user.name} (${user.email})`,
      req
    });

    return res.status(201).json({
      success: true,
      message: `Pengguna ${user.name} berhasil dibuat dengan peran ${user.role}.`,
      user
    });
  } catch (err) {
    console.error('[adminController] createUser error:', err);
    return res.status(500).json({ success: false, error: 'Gagal membuat pengguna baru' });
  }
}

/**
 * PUT /api/admin/users/:id/role
 * Change user role with safeguards
 */
async function updateUserRole(req, res) {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ['ADMIN', 'USER'];
    if (!role || !validRoles.includes(role.toUpperCase())) {
      return res.status(400).json({ success: false, error: 'Peran tidak valid. Pilihan: ADMIN atau USER.' });
    }

    const targetRole = role.toUpperCase();

    const targetUser = await prisma.user.findUnique({
      where: { id }
    });

    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
    }

    // Safety: jika menurunkan role Admin, pastikan masih ada Admin lain
    if (targetUser.role === 'ADMIN' && targetRole !== 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Tidak dapat mengubah peran Admin terakhir. Sistem wajib memiliki minimal 1 Administrator aktif.'
        });
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role: targetRole },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        updatedAt: true
      }
    });

    await logAdminAction({
      action: 'ROLE_CHANGED',
      details: { previousRole: targetUser.role, newRole: targetRole },
      targetId: targetUser.id,
      targetName: `${targetUser.name} (${targetUser.email})`,
      req
    });

    return res.json({
      success: true,
      message: `Peran ${updated.name} berhasil diubah menjadi ${updated.role}.`,
      user: updated
    });
  } catch (err) {
    console.error('[adminController] updateUserRole error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengubah peran pengguna' });
  }
}

/**
 * PUT /api/admin/users/:id/reset-password
 * Reset user password by Admin
 */
async function resetUserPassword(req, res) {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password baru minimal 6 karakter.' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id }
    });

    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id },
      data: { password: hashedPassword }
    });

    await logAdminAction({
      action: 'PASSWORD_RESET',
      details: 'Password direset oleh Administrator.',
      targetId: targetUser.id,
      targetName: `${targetUser.name} (${targetUser.email})`,
      req
    });

    return res.json({
      success: true,
      message: `Password untuk akun ${targetUser.name} (${targetUser.email}) berhasil diperbarui.`
    });
  } catch (err) {
    console.error('[adminController] resetUserPassword error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mereset password pengguna' });
  }
}

/**
 * DELETE /api/admin/users/:id
 * Delete user account with comprehensive safety guards
 */
async function deleteUser(req, res) {
  try {
    const { id } = req.params;

    // Safety rule 1: Admin tidak boleh menghapus dirinya sendiri
    if (req.user.id === id) {
      return res.status(400).json({
        success: false,
        error: 'Anda tidak dapat menghapus akun Anda sendiri yang sedang aktif digunakan.'
      });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id }
    });

    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
    }

    // Safety rule 2: Jika target adalah ADMIN, pastikan bukan satu-satunya ADMIN
    if (targetUser.role === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Tidak dapat menghapus Administrator terakhir. Sistem wajib memiliki minimal 1 Administrator aktif.'
        });
      }
    }

    await prisma.user.delete({
      where: { id }
    });

    await logAdminAction({
      action: 'USER_DELETED',
      details: { deletedEmail: targetUser.email, deletedRole: targetUser.role },
      targetId: targetUser.id,
      targetName: `${targetUser.name} (${targetUser.email})`,
      req
    });

    return res.json({
      success: true,
      message: `Akun pengguna ${targetUser.name} (${targetUser.email}) telah berhasil dihapus dari sistem.`
    });
  } catch (err) {
    console.error('[adminController] deleteUser error:', err);
    return res.status(500).json({ success: false, error: 'Gagal menghapus pengguna' });
  }
}

/**
 * GET /api/admin/registration-codes
 * List all registration / invite codes
 */
async function getRegistrationCodes(req, res) {
  try {
    const codes = await prisma.registrationCode.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const now = new Date();

    const formattedCodes = codes.map((c) => {
      let status = 'ACTIVE';
      if (!c.isActive) {
        status = 'INACTIVE';
      } else if (c.expiresAt && now > new Date(c.expiresAt)) {
        status = 'EXPIRED';
      } else if (c.maxUses > 0 && c.usedCount >= c.maxUses) {
        status = 'EXHAUSTED';
      }

      return {
        ...c,
        status,
        remainingUses: c.maxUses > 0 ? Math.max(c.maxUses - c.usedCount, 0) : 'UNLIMITED'
      };
    });

    const summary = {
      total: codes.length,
      active: formattedCodes.filter(c => c.status === 'ACTIVE').length,
      expired: formattedCodes.filter(c => c.status === 'EXPIRED').length,
      exhausted: formattedCodes.filter(c => c.status === 'EXHAUSTED').length,
      inactive: formattedCodes.filter(c => c.status === 'INACTIVE').length
    };

    return res.json({
      success: true,
      data: {
        codes: formattedCodes,
        summary
      }
    });
  } catch (err) {
    console.error('[adminController] getRegistrationCodes error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengambil daftar kode registrasi' });
  }
}

/**
 * POST /api/admin/registration-codes
 * Generate a new registration code with role, quota, and expiration
 */
async function createRegistrationCode(req, res) {
  try {
    const {
      code,
      role = 'USER',
      maxUses = 1,
      expiresInDays,
      expiresAt,
      description = ''
    } = req.body;

    const validRoles = ['ADMIN', 'USER'];
    const targetRole = validRoles.includes(String(role).toUpperCase()) ? String(role).toUpperCase() : 'USER';

    let finalCode = (code || '').trim().toUpperCase();
    if (!finalCode) {
      finalCode = generateReadableCode('REG');
    }

    // Cek duplikasi kode
    const existing = await prisma.registrationCode.findUnique({
      where: { code: finalCode }
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        error: `Kode '${finalCode}' sudah pernah dibuat sebelumnya. Gunakan kode lain atau biarkan kosong untuk generate otomatis.`
      });
    }

    let calculatedExpiresAt = null;
    if (expiresAt) {
      calculatedExpiresAt = new Date(expiresAt);
    } else if (expiresInDays !== undefined && expiresInDays !== null && Number(expiresInDays) > 0) {
      calculatedExpiresAt = new Date();
      calculatedExpiresAt.setDate(calculatedExpiresAt.getDate() + Number(expiresInDays));
    }

    const parsedMaxUses = maxUses === null || maxUses === undefined ? 1 : Math.max(Number(maxUses) || 0, 0);

    const record = await prisma.registrationCode.create({
      data: {
        code: finalCode,
        role: targetRole,
        maxUses: parsedMaxUses,
        usedCount: 0,
        isActive: true,
        expiresAt: calculatedExpiresAt,
        description: description ? description.trim() : null,
        createdById: req.user.id,
        createdByName: req.user.name
      }
    });

    await logAdminAction({
      action: 'CODE_GENERATED',
      details: {
        code: record.code,
        role: record.role,
        maxUses: record.maxUses,
        expiresAt: record.expiresAt,
        description: record.description
      },
      targetId: record.id,
      targetName: record.code,
      req
    });

    return res.status(201).json({
      success: true,
      message: `Kode registrasi ${record.code} berhasil dibuat untuk peran ${record.role}.`,
      code: record
    });
  } catch (err) {
    console.error('[adminController] createRegistrationCode error:', err);
    return res.status(500).json({ success: false, error: 'Gagal membuat kode registrasi baru' });
  }
}

/**
 * PATCH /api/admin/registration-codes/:id/toggle
 * Toggle active state of a registration code
 */
async function toggleRegistrationCode(req, res) {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const existing = await prisma.registrationCode.findUnique({
      where: { id }
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kode registrasi tidak ditemukan.' });
    }

    const nextActive = isActive !== undefined ? Boolean(isActive) : !existing.isActive;

    const updated = await prisma.registrationCode.update({
      where: { id },
      data: { isActive: nextActive }
    });

    await logAdminAction({
      action: 'CODE_TOGGLED',
      details: { code: updated.code, newStatus: nextActive ? 'ACTIVE' : 'INACTIVE' },
      targetId: updated.id,
      targetName: updated.code,
      req
    });

    return res.json({
      success: true,
      message: `Kode ${updated.code} sekarang ${nextActive ? 'diaktifkan' : 'dinonaktifkan'}.`,
      code: updated
    });
  } catch (err) {
    console.error('[adminController] toggleRegistrationCode error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengubah status kode registrasi' });
  }
}

/**
 * DELETE /api/admin/registration-codes/:id
 * Delete a registration code
 */
async function deleteRegistrationCode(req, res) {
  try {
    const { id } = req.params;

    const existing = await prisma.registrationCode.findUnique({
      where: { id }
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Kode registrasi tidak ditemukan.' });
    }

    await prisma.registrationCode.delete({
      where: { id }
    });

    await logAdminAction({
      action: 'CODE_DELETED',
      details: { code: existing.code, role: existing.role, usedCount: existing.usedCount },
      targetId: existing.id,
      targetName: existing.code,
      req
    });

    return res.json({
      success: true,
      message: `Kode registrasi ${existing.code} berhasil dihapus.`
    });
  } catch (err) {
    console.error('[adminController] deleteRegistrationCode error:', err);
    return res.status(500).json({ success: false, error: 'Gagal menghapus kode registrasi' });
  }
}

/**
 * GET /api/admin/audit-logs
 * Fetch administrative activity audit logs
 */
async function getAuditLogs(req, res) {
  try {
    const { limit = 50, action = '' } = req.query;

    const where = {};
    if (action) {
      where.action = action;
    }

    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);

    const logs = await prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take
    });

    return res.json({
      success: true,
      data: {
        logs
      }
    });
  } catch (err) {
    console.error('[adminController] getAuditLogs error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengambil log audit' });
  }
}

/**
 * GET /api/admin/stores
 * List all stores across all users with product counts and sync statuses
 */
async function getAdminStores(req, res) {
  try {
    const stores = await prisma.storeSession.findMany({
      select: {
        id: true,
        storeName: true,
        storeId: true,
        isActive: true,
        isCustomName: true,
        lastSyncedAt: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true
          }
        },
        _count: {
          select: {
            products: true,
            orderSummaries: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const totalStores = stores.length;
    const activeStores = stores.filter((s) => s.isActive).length;

    return res.json({
      success: true,
      data: {
        stores,
        totalStores,
        activeStores
      }
    });
  } catch (err) {
    console.error('[adminController] getAdminStores error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengambil daftar seluruh toko' });
  }
}

/**
 * GET /api/admin/system-stats
 * Comprehensive system and security health stats
 */
async function getSystemStats(req, res) {
  try {
    const dbStartTime = Date.now();
    const userCount = await prisma.user.count();
    const dbLatencyMs = Date.now() - dbStartTime;

    const [adminCount, userRoleCount, storeCount, activeCodesCount, totalAuditLogs] = await Promise.all([
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.storeSession.count(),
      prisma.registrationCode.count({ where: { isActive: true } }),
      prisma.adminAuditLog.count()
    ]);

    const systemInfo = {
      dbStatus: 'CONNECTED',
      dbLatencyMs,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
      jwtConfigured: Boolean(process.env.JWT_SECRET),
      envRegistrationSecretConfigured: Boolean(process.env.REGISTRATION_SECRET),
      counts: {
        totalUsers: userCount,
        adminUsers: adminCount,
        regularUsers: userRoleCount,
        totalStores: storeCount,
        activeCodes: activeCodesCount,
        auditLogs: totalAuditLogs
      }
    };

    return res.json({
      success: true,
      data: systemInfo
    });
  } catch (err) {
    console.error('[adminController] getSystemStats error:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengambil statistik sistem' });
  }
}

module.exports = wrapHandlers({
  getUsers,
  createUser,
  updateUserRole,
  resetUserPassword,
  deleteUser,
  getRegistrationCodes,
  createRegistrationCode,
  toggleRegistrationCode,
  deleteRegistrationCode,
  getAuditLogs,
  getAdminStores,
  getSystemStats
});
