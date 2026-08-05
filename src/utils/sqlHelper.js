/**
 * Database-agnostic SQL helper for Prisma raw queries (SQLite & PostgreSQL)
 */
function isPostgres() {
  const url = process.env.DATABASE_URL || '';
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

function adaptSql(sql, params = []) {
  if (!isPostgres()) {
    return { sql, params };
  }

  let paramIndex = 1;
  let adapted = sql.replace(/\?/g, () => `$${paramIndex++}`);
  // PostgreSQL does not support COLLATE NOCASE in this syntax; remove it as lower() handles case-insensitivity
  adapted = adapted.replace(/COLLATE\s+NOCASE/gi, '');
  return { sql: adapted, params };
}

async function queryRaw(prismaClient, sql, ...params) {
  const { sql: adaptedSql, params: adaptedParams } = adaptSql(sql, params);
  return prismaClient.$queryRawUnsafe(adaptedSql, ...adaptedParams);
}

async function executeRaw(prismaClient, sql, ...params) {
  const { sql: adaptedSql, params: adaptedParams } = adaptSql(sql, params);
  return prismaClient.$executeRawUnsafe(adaptedSql, ...adaptedParams);
}

module.exports = {
  isPostgres,
  adaptSql,
  queryRaw,
  executeRaw,
};
