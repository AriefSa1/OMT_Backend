/**
 * Answers the question the rest of the SKU-mapping work depends on:
 * do Shopee variation SKUs match warehouse SKUs?
 *
 * Run this AFTER a real catalog sync has populated ShopeeListingVariation.
 *
 *   DATABASE_URL="file:./prisma/dev.db" node src/scripts/checkSkuMappingFeasibility.js
 *
 * Read-only. Writes nothing.
 *
 * If the exact-match count is high, an automatic mapping tier can do most of the work.
 * If it is zero, mapping is a manual job — but a small one: the workload is the number
 * of Shopee sellable units (tens), not the number of warehouse SKUs (tens of thousands),
 * because a Shopee listing is a set assembled from several warehouse components.
 */
const prisma = require('../utils/prisma');

function normalise(value) {
  return String(value || '').trim().toUpperCase();
}

async function main() {
  const [variations, products, warehouseSkus] = await Promise.all([
    prisma.shopeeListingVariation.findMany({
      select: { shopeeItemId: true, shopeeModelId: true, variationSku: true, name: true, stock: true },
    }),
    prisma.shopeeProduct.findMany({ select: { shopeeItemId: true, sku: true, name: true } }),
    prisma.warehouseItem.findMany({ select: { sku: true }, distinct: ['sku'] }),
  ]);

  const warehouseSet = new Set(warehouseSkus.map((row) => normalise(row.sku)));

  console.log('=== Sumber data ===');
  console.log(`  Listing Shopee            : ${products.length}`);
  console.log(`  Varian Shopee tersimpan   : ${variations.length}`);
  console.log(`  SKU gudang unik           : ${warehouseSet.size}`);

  if (!variations.length) {
    console.log('\n  Belum ada varian tersimpan. Jalankan sinkronisasi katalog lebih dulu,');
    console.log('  lalu ulangi skrip ini.');
    return;
  }

  const withSku = variations.filter((row) => normalise(row.variationSku));
  const matched = withSku.filter((row) => warehouseSet.has(normalise(row.variationSku)));

  console.log('\n=== Tingkat 1: SKU varian persis ===');
  console.log(`  Varian yang punya SKU     : ${withSku.length} dari ${variations.length}`);
  console.log(`  Cocok dengan SKU gudang   : ${matched.length}`);

  const parentMatched = products.filter((row) => warehouseSet.has(normalise(row.sku)));
  console.log('\n=== Tingkat 2: SKU induk persis ===');
  console.log(`  Cocok dengan SKU gudang   : ${parentMatched.length} dari ${products.length}`);

  const coverage = withSku.length ? Math.round((matched.length / withSku.length) * 100) : 0;
  console.log('\n=== Kesimpulan ===');
  if (matched.length === 0) {
    console.log('  TIDAK ADA kecocokan otomatis. Pemetaan harus manual.');
    console.log(`  Beban kerja: ${variations.length} unit jual Shopee, masing-masing dipilihkan`);
    console.log('  komponen SKU gudang-nya — bukan puluhan ribu baris.');
  } else if (coverage >= 80) {
    console.log(`  ${coverage}% varian ber-SKU cocok otomatis. Pemetaan manual hanya untuk sisanya.`);
  } else {
    console.log(`  ${coverage}% varian ber-SKU cocok otomatis. Sisanya perlu dipetakan manual.`);
  }

  if (matched.length) {
    console.log('\n  Contoh kecocokan:');
    for (const row of matched.slice(0, 5)) {
      console.log(`    ${row.variationSku}  (${row.name || 'tanpa nama'}, stok ${row.stock})`);
    }
  }

  const unmatchedSamples = withSku.filter((row) => !warehouseSet.has(normalise(row.variationSku))).slice(0, 5);
  if (unmatchedSamples.length) {
    console.log('\n  Contoh SKU varian yang TIDAK cocok (untuk memeriksa format):');
    for (const row of unmatchedSamples) {
      console.log(`    "${row.variationSku}"  (${row.name || 'tanpa nama'})`);
    }
  }
}

main()
  .catch((error) => {
    console.error('Gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
