require('dotenv').config();
const prisma = require('../utils/prisma');

const DIVISOR = 100000;

async function migrate() {
  const legacyRows = await prisma.shopeeAdsData.findMany({
    where: {
      rawSpend: 0,
      rawSales: 0,
      amountDivisor: DIVISOR,
      OR: [{ spend: { gt: 0 } }, { sales: { gt: 0 } }, { voucherSpend: { gt: 0 } }, { voucherSales: { gt: 0 } }],
    },
  });
  if (!legacyRows.length) {
    console.log('Tidak ada snapshot iklan lama yang perlu dinormalisasi.');
    return;
  }
  await prisma.$transaction(legacyRows.map((row) => prisma.shopeeAdsData.update({
    where: { id: row.id },
    data: {
      rawSpend: row.spend,
      rawSales: row.sales,
      rawVoucherSpend: row.voucherSpend,
      rawVoucherSales: row.voucherSales,
      amountDivisor: DIVISOR,
      spend: row.spend / DIVISOR,
      sales: row.sales / DIVISOR,
      voucherSpend: row.voucherSpend / DIVISOR,
      voucherSales: row.voucherSales / DIVISOR,
    },
  })));
  console.log(`${legacyRows.length} snapshot iklan dinormalisasi dengan pembagi ${DIVISOR}.`);
}

migrate()
  .catch((error) => {
    console.error('Migrasi nominal iklan gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
