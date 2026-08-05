const { execSync } = require('child_process');

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./dev.db';
}

function createPrismaClient() {
  const options = {
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  };

  try {
    const { PrismaClient } = require('@prisma/client');
    return new PrismaClient(options);
  } catch (err) {
    console.warn('[Prisma] Client not initialized yet. Executing auto npx prisma generate...');
    try {
      execSync('npx prisma generate', { stdio: 'inherit' });
      // Invalidate node require cache for freshly generated client
      Object.keys(require.cache).forEach((key) => {
        if (key.includes('@prisma/client') || key.includes('.prisma')) {
          delete require.cache[key];
        }
      });
      const { PrismaClient } = require('@prisma/client');
      return new PrismaClient(options);
    } catch (genErr) {
      try {
        const { PrismaClient } = require('../../node_modules/.prisma/client-active');
        return new PrismaClient(options);
      } catch {
        console.error('[Prisma] Fatal error starting Prisma Client:', err.message);
        throw err;
      }
    }
  }
}

const globalForPrisma = global;
const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
