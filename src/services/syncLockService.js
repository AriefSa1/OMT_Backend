const crypto = require('crypto');
const prisma = require('../utils/prisma');

const LOCK_KEY = 'DATA_SYNC';
const DEFAULT_TTL_MS = 20 * 60 * 1000;

class SyncLockService {
  constructor() {
    this.processOwner = `${process.pid}`;
  }

  async acquire(key = LOCK_KEY, ttlMs = DEFAULT_TTL_MS) {
    const owner = `${this.processOwner}-${crypto.randomUUID()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    await prisma.$executeRaw`
      INSERT INTO "SyncRunLock" ("key", "owner", "acquiredAt", "expiresAt")
      VALUES (${key}, ${owner}, ${now}, ${expiresAt})
      ON CONFLICT("key") DO UPDATE SET
        "owner" = excluded."owner",
        "acquiredAt" = excluded."acquiredAt",
        "expiresAt" = excluded."expiresAt"
      WHERE "SyncRunLock"."expiresAt" <= ${now}
    `;

    const lock = await prisma.syncRunLock.findUnique({ where: { key } });
    return lock?.owner === owner ? owner : null;
  }

  async release(key = LOCK_KEY, owner) {
    if (!owner) return;
    await prisma.syncRunLock.deleteMany({ where: { key, owner } });
  }

  async runExclusive(fn, { key = LOCK_KEY, ttlMs = DEFAULT_TTL_MS } = {}) {
    const owner = await this.acquire(key, ttlMs);
    if (!owner) {
      const error = new Error('Sinkronisasi sedang berjalan pada runtime lain. Coba lagi setelah proses selesai.');
      error.code = 'SYNC_ALREADY_RUNNING';
      return { acquired: false, error };
    }

    try {
      return { acquired: true, value: await fn() };
    } finally {
      await this.release(key, owner).catch((error) => {
        console.warn('[Sync Lock] Failed to release lock:', error.message);
      });
    }
  }
}

module.exports = new SyncLockService();
