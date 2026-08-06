const { randomUUID } = require('crypto');
const prisma = require('../utils/prisma');
const { adaptSql } = require('../utils/sqlHelper');
const { selectChangedRows } = require('../utils/rowHash');
const shopeeService = require('./shopeeService');
const shopeeInsightsService = require('./shopeeInsightsService');
const warehouseService = require('./warehouseService');
const snapshotService = require('./snapshotService');
const syncLockService = require('./syncLockService');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRate(value) {
  const parsed = number(value);
  return parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
}

function firstValue(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) return candidate;
  }
  return null;
}

function findNestedValue(value, matcher, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNestedValue(entry, matcher, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (matcher(key) && candidate !== undefined && candidate !== null && String(candidate).trim()) return candidate;
    if (candidate && typeof candidate === 'object') {
      const found = findNestedValue(candidate, matcher, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findNestedCategoryPath(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return [];
  if (Array.isArray(value)) return [];
  for (const [key, candidate] of Object.entries(value)) {
    if (Array.isArray(candidate) && /categor(y|ies).*(path|list)|cat.*path/i.test(key)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const path = findNestedCategoryPath(candidate, depth + 1);
      if (path.length) return path;
    }
  }
  return [];
}

function categoryValue(row, level, field = 'id') {
  const group = row?.[`l${level}_category`] || row?.[`category_l${level}`] || row?.[`level_${level}_category`] || {};
  const identifiers = [`l${level}_category_id`, `l${level}catid`, `l${level}_cat_id`, `category_l${level}_id`, `level_${level}_category_id`];
  const names = [`l${level}_category_name`, `l${level}_category_display_name`, `category_l${level}_name`, `level_${level}_category_name`];
  const direct = firstValue(row, field === 'id' ? identifiers : names);
  if (direct) return String(direct);
  const groupValue = firstValue(group, field === 'id' ? ['id', 'category_id', 'catid'] : ['display_name', 'name']);
  if (groupValue) return String(groupValue);
  const nested = findNestedValue(row, (key) => field === 'id'
    ? new RegExp(`(^|_)l?${level}(_|$).*?(category|cat).*?(id)?$|^(category|cat).*?l?${level}.*?(id)?$`, 'i').test(key)
    : new RegExp(`(^|_)(l?${level}).*?(category|cat).*?(name|display)|^(category|cat).*?l?${level}.*?(name|display)`, 'i').test(key));
  if (nested) return String(nested);
  const path = findNestedCategoryPath(row);
  const entry = path.find((item) => Number(item?.level ?? item?.category_level) === level) || path[level] || path[level - 1];
  if (!entry) return null;
  const pathValue = field === 'id' ? firstValue(entry, ['id', 'category_id', 'catid']) : firstValue(entry, ['display_name', 'name']);
  return pathValue ? String(pathValue) : null;
}

function asDateKey(date = new Date()) {
  return snapshotService.dateKey(date);
}

class SyncService {
  async writeLog(jobType, status, message, timestamp = new Date()) {
    return prisma.syncJobLog.create({ data: { jobType, status, message, timestamp } });
  }

  async persistProductMetrics(storeId, performance = []) {
    if (!storeId || !Array.isArray(performance) || !performance.length) return 0;
    const date = asDateKey();
    const dataAsOf = new Date();
    const knownProducts = await prisma.shopeeProduct.findMany({
      where: { storeId },
      select: { shopeeItemId: true, name: true, category: true },
    });
    const byId = new Map(knownProducts.map((product) => [product.shopeeItemId, product]));
    const byName = new Map(knownProducts.map((product) => [product.name.trim().toLowerCase(), product]));
    const productUpdates = [];
    const records = performance.map((row) => {
      const itemId = String(row.item_id ?? row.itemid ?? row.product_id ?? row.id ?? '');
      const matched = byId.get(itemId) || byName.get(String(row.name || row.product_name || '').trim().toLowerCase());
      if (!matched) return null;
      const l2CategoryId = categoryValue(row, 2, 'id');
      const l3CategoryId = categoryValue(row, 3, 'id');
      const l2CategoryName = categoryValue(row, 2, 'name');
      const l3CategoryName = categoryValue(row, 3, 'name');
      if (l2CategoryId || l3CategoryId || l2CategoryName || l3CategoryName) {
        productUpdates.push(prisma.shopeeProduct.update({
          where: { shopeeItemId: matched.shopeeItemId },
          data: {
            ...(l2CategoryId ? { l2CategoryId } : {}),
            ...(l3CategoryId ? { l3CategoryId } : {}),
            ...(l2CategoryName ? { l2CategoryName } : {}),
            ...(l3CategoryName ? { l3CategoryName } : {}),
          },
        }));
      }
      const impressions = number(row.product_card_impressions ?? row.impressions ?? row.impression);
      const clicks = number(row.clicks ?? row.product_click);
      const views = number(row.pv ?? row.item_views ?? row.views ?? impressions);
      const visitors = number(row.uv ?? row.item_uv ?? row.unique_visitors);
      const addToCartUnits = number(row.add_to_cart_units ?? row.cart_units);
      const confirmedOrders = number(row.confirmed_orders ?? row.confirmed_order ?? row.order_count);
      const confirmedUnits = number(row.confirmed_units ?? row.units_sold ?? row.item_sold);
      const confirmedBuyers = number(row.confirmed_buyers ?? row.buyers);
      return {
        storeId,
        shopeeItemId: matched.shopeeItemId,
        date,
        productName: matched.name,
        category: matched.category || 'Tanpa kategori',
        impressions,
        views,
        visitors,
        clicks,
        ctr: normalizeRate(row.ctr ?? (impressions > 0 ? (clicks / impressions) * 100 : 0)),
        bounceRate: normalizeRate(row.bounce_rate),
        addToCartBuyers: number(row.add_to_cart_buyers ?? row.add_to_cart),
        addToCartUnits,
        confirmedOrders,
        confirmedUnits,
        confirmedBuyers,
        confirmedSales: number(row.confirmed_sales ?? row.confirmed_gmv ?? row.sales),
        conversionRate: normalizeRate(row.conversion_rate ?? row.confirmed_order_conversion_rate
          ?? (visitors > 0 ? (confirmedOrders / visitors) * 100 : 0)),
        dataAsOf,
      };
    }).filter(Boolean);
    if (!records.length) return 0;
    await prisma.$transaction([
      ...records.map((record) => prisma.productMetricSnapshot.upsert({
      where: { storeId_shopeeItemId_date: { storeId: record.storeId, shopeeItemId: record.shopeeItemId, date: record.date } },
      update: record,
      create: record,
      })),
      ...productUpdates,
    ]);
    return records.length;
  }

  /**
   * `dateOverride` dipakai saat mengisi mundur riwayat (backfillAdsHistory): tanpa itu
   * setiap hari lampau akan tertulis ke tanggal hari ini dan saling menimpa.
   */
  async persistAdsSnapshot(metrics, { date: dateOverride = null } = {}) {
    if (!metrics?.success || !metrics.storeId) return null;
    const date = dateOverride || asDateKey();
    const dataAsOf = new Date();
    const total = {
      storeId: metrics.storeId,
      date,
      spend: number(metrics.totalSpend),
      sales: number(metrics.totalSalesGenerated),
      roas: number(metrics.roas),
      impressions: number(metrics.impressions),
      clicks: number(metrics.clicks),
      ctr: normalizeRate(metrics.ctr),
      rawSpend: number(metrics.rawSpend),
      rawSales: number(metrics.rawSales),
      rawVoucherSpend: number(metrics.rawVoucherSpend),
      rawVoucherSales: number(metrics.rawVoucherSales),
      amountDivisor: number(metrics.amountDivisor) || 100000,
      voucherSpend: number(metrics.voucherSpend),
      voucherSales: number(metrics.voucherSales),
      dataAsOf,
    };
    await prisma.$transaction([
      prisma.shopeeAdsData.upsert({
        where: { storeId_date: { storeId: total.storeId, date } },
        update: total,
        create: total,
      }),
      ...metrics.topCampaigns.map((campaign) => prisma.shopeeAdsCampaignSnapshot.upsert({
        where: { storeId_campaignId_date: { storeId: metrics.storeId, campaignId: campaign.id, date } },
        update: {
          name: campaign.name,
          type: campaign.type,
          state: campaign.state,
          dailyBudget: number(campaign.dailyBudget),
          spend: number(campaign.spend),
          sales: number(campaign.sales),
          rawSpend: number(campaign.rawSpend),
          rawSales: number(campaign.rawSales),
          rawDailyBudget: number(campaign.rawDailyBudget),
          amountDivisor: number(campaign.amountDivisor) || 100000,
          impressions: number(campaign.impressions),
          clicks: number(campaign.clicks),
          ctr: normalizeRate(campaign.ctr),
          roas: number(campaign.roas),
          voucherSpend: number(campaign.voucherSpend),
          voucherSales: number(campaign.voucherSales),
          rawVoucherSpend: number(campaign.rawVoucherSpend),
          rawVoucherSales: number(campaign.rawVoucherSales),
          dataAsOf,
        },
        create: {
          storeId: metrics.storeId,
          campaignId: campaign.id,
          date,
          name: campaign.name,
          type: campaign.type,
          state: campaign.state,
          dailyBudget: number(campaign.dailyBudget),
          spend: number(campaign.spend),
          sales: number(campaign.sales),
          rawSpend: number(campaign.rawSpend),
          rawSales: number(campaign.rawSales),
          rawDailyBudget: number(campaign.rawDailyBudget),
          amountDivisor: number(campaign.amountDivisor) || 100000,
          impressions: number(campaign.impressions),
          clicks: number(campaign.clicks),
          ctr: normalizeRate(campaign.ctr),
          roas: number(campaign.roas),
          voucherSpend: number(campaign.voucherSpend),
          voucherSales: number(campaign.voucherSales),
          rawVoucherSpend: number(campaign.rawVoucherSpend),
          rawVoucherSales: number(campaign.rawVoucherSales),
          dataAsOf,
        },
      })),
    ]);
    return { date, campaignCount: metrics.topCampaigns.length, dataAsOf };
  }

  /**
   * Mengisi mundur riwayat harian iklan.
   *
   * Alasannya: `ShopeeOrderSummary` punya 30+ hari (satu panggilan key-metrics membawa
   * seluruh deret), sedangkan `ShopeeAdsData` hanya bertambah satu baris per hari saat
   * sync berjalan — jadi grafik tren menggambar GMV 30 hari berdampingan dengan biaya
   * iklan yang hanya beberapa hari terakhir.
   *
   * Endpoint iklan Shopee hanya menerima satu rentang waktu per panggilan dan
   * mengembalikan totalnya, bukan deret harian. Jadi satu-satunya cara mendapat riwayat
   * harian adalah memanggilnya sekali per hari — sudah diverifikasi Shopee melayani
   * tanggal lampau. Karena itu fungsi ini mahal (satu request per hari) dan tidak
   * dijalankan otomatis oleh cron; panggil manual saat memang perlu mengisi lubang.
   *
   * Hari yang sudah punya baris dilewati kecuali `overwrite: true`.
   */
  async backfillAdsHistorySingleStore(storeId, { days = 30, overwrite = false } = {}) {
    const safeDays = Math.min(90, Math.max(1, Number(days) || 30));
    const existing = new Set(
      overwrite ? [] : (await prisma.shopeeAdsData.findMany({
        where: { storeId },
        select: { date: true },
      })).map((row) => row.date)
    );

    const results = { filled: 0, skipped: 0, failed: 0, dates: [] };
    for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
      const target = new Date(Date.now() - offset * 86400000);
      const dateKey = asDateKey(target);
      if (existing.has(dateKey)) {
        results.skipped += 1;
        continue;
      }

      const [year, month, day] = dateKey.split('-').map(Number);
      const startTime = Math.floor(Date.UTC(year, month - 1, day, -7, 0, 0) / 1000);
      const endTime = startTime + 86399;

      try {
        const metrics = await shopeeService.fetchShopeeAdsMetrics({ period: 'custom', startTime, endTime, storeId });
        if (!metrics?.success) {
          results.failed += 1;
          continue;
        }
        await this.persistAdsSnapshot(metrics, { date: dateKey });
        results.filled += 1;
        results.dates.push(dateKey);
      } catch (err) {
        console.warn(`[Sync] Backfill iklan ${dateKey} (${storeId}) gagal:`, err.message);
        results.failed += 1;
      }
    }

    const message = `[${storeId}] Riwayat iklan: ${results.filled} hari terisi, ${results.skipped} dilewati (sudah ada), ${results.failed} gagal.`;
    await this.writeLog('ADS_BACKFILL', results.failed && !results.filled ? 'FAILED' : 'SUCCESS', message);
    return { success: true, storeId, ...results, message };
  }

  async backfillAdsHistory({ days = 30, overwrite = false, storeId = null } = {}) {
    if (storeId) {
      return this.backfillAdsHistorySingleStore(storeId, { days, overwrite });
    }
    const allSessions = await shopeeService.getAllSessions();
    const activeSessions = allSessions.filter((s) => s.isActive);
    if (!activeSessions.length) {
      const fallback = await shopeeService.getActiveSession();
      if (fallback?.storeId) {
        return this.backfillAdsHistorySingleStore(fallback.storeId, { days, overwrite });
      }
      return { success: false, filled: 0, skipped: 0, failed: 0, message: 'Tidak ada sesi Shopee aktif.' };
    }

    const results = [];
    for (const session of activeSessions) {
      const res = await this.backfillAdsHistorySingleStore(session.storeId, { days, overwrite });
      results.push(res);
    }
    return {
      success: true,
      storeResults: results,
      filled: results.reduce((acc, r) => acc + (r.filled || 0), 0),
      skipped: results.reduce((acc, r) => acc + (r.skipped || 0), 0),
      failed: results.reduce((acc, r) => acc + (r.failed || 0), 0),
      message: `Backfill iklan untuk ${activeSessions.length} toko selesai.`,
    };
  }

  async persistWarehouseSnapshots(items, source) {
    if (!Array.isArray(items) || !items.length) return 0;
    const date = asDateKey();
    const dataAsOf = new Date();
    const records = items.filter((item) => item.sku).map((item) => ({
      sku: String(item.sku),
      date,
      name: item.name || '',
      totalStock: number(item.totalStock),
      reservedStock: number(item.reservedStock),
      availableStock: number(item.availableStock ?? item.warehouseStock),
      warehouseId: item.warehouseId ? number(item.warehouseId) : null,
      warehouseName: item.warehouseName || null,
      teamId: item.teamId ? number(item.teamId) : null,
      teamName: item.teamName || null,
      productType: item.productType || 'general',
      source: source || 'WAREHOUSE_API',
      dataAsOf,
    }));
    // Satu upsert Prisma per baris berarti satu perjalanan ke basis data per baris: untuk
    // katalog 27 ribu SKU itu 27 ribu perjalanan, yang terhadap Neon (Singapura) memakan
    // waktu berpuluh menit dan membuat sync gudang seolah menggantung. Diganti dengan
    // INSERT banyak-baris yang dipotong-potong, persis pola persistItems di
    // warehouseService — statement disusun dulu lalu dijalankan sebagai satu transaksi
    // array, sehingga tetap atomik.
    //
    // Catatan tentang NULL: kunci uniknya (sku, warehouseId, date) memuat kolom nullable,
    // dan di PostgreSQL NULL tidak pernah sama dengan NULL sehingga ON CONFLICT tidak akan
    // mengenali baris lama bila warehouseId kosong. Baris seperti itu memang tidak
    // seharusnya ada di sini — semuanya berasal dari gudang aktif — jadi disaring lebih
    // dulu daripada diam-diam menumpuk duplikat setiap hari.
    //
    // Dedup: PostgreSQL menolak satu perintah INSERT yang menyentuh baris konflik yang sama
    // dua kali ("ON CONFLICT DO UPDATE command cannot affect row a second time"), sedangkan
    // upsert satu per satu dulu diam-diam saling menimpa. Perilaku lama dipertahankan
    // (entri terakhir menang) tetapi sekarang dilakukan sebelum SQL dibentuk.
    const deduped = new Map();
    for (const record of records) {
      if (record.warehouseId === null || record.warehouseId === undefined) continue;
      deduped.set(`${record.sku}:${record.warehouseId}:${record.date}`, record);
    }
    const persistable = [...deduped.values()];
    if (!persistable.length) return 0;

    const columns = [
      'id', 'sku', 'date', 'name', 'totalStock', 'reservedStock', 'availableStock',
      'warehouseId', 'warehouseName', 'teamId', 'teamName', 'productType', 'source',
      'dataAsOf', 'updatedAt', 'contentHash',
    ];
    const updateColumns = columns.filter((column) => !['id', 'sku', 'warehouseId', 'date'].includes(column));
    const chunkSize = Math.max(1, Math.floor(30000 / columns.length));
    const updatedAt = new Date();

    // Sama seperti persistItems: yang mahal adalah mengirim muatannya, bukan kerja tulis di
    // sisi server. Baris yang isinya tidak berubah tidak dikirim ulang; `dataAsOf` dan
    // `updatedAt` dikecualikan dari sidik jari lalu disegarkan lewat satu UPDATE menyeluruh
    // supaya artinya tetap "terakhir disentuh sync".
    //
    // Batas yang sama seperti di persistItems berlaku: sidik jari mencatat apa yang terakhir
    // ditulis, bukan isi baris sekarang. Di sini tidak perlu penanganan khusus — kuncinya
    // memuat `date`, jadi sync pertama setiap hari tidak menemukan baris sebelumnya dan
    // menulis seluruh 27 ribu baris apa adanya.
    const hashedColumns = updateColumns.filter((column) => !['dataAsOf', 'updatedAt', 'contentHash'].includes(column));
    const previousRows = await prisma.warehouseStockSnapshot.findMany({
      where: { date },
      select: { id: true, sku: true, warehouseId: true, contentHash: true },
    });
    const previousById = new Map(previousRows.map((row) => [`${row.sku}:${row.warehouseId}`, row.id]));
    const { changed } = selectChangedRows(persistable, {
      columns: hashedColumns,
      keyOf: (record) => `${record.sku}:${record.warehouseId}`,
      previousHashes: new Map(previousRows.map((row) => [`${row.sku}:${row.warehouseId}`, row.contentHash])),
    });

    const statements = [];
    for (let index = 0; index < changed.length; index += chunkSize) {
      const chunk = changed.slice(index, index + chunkSize).map((record) => ({
        ...record,
        id: previousById.get(`${record.sku}:${record.warehouseId}`) || randomUUID(),
        updatedAt,
      }));
      const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
      const values = chunk.flatMap((record) => columns.map((column) => record[column]));
      const sql = `INSERT INTO "WarehouseStockSnapshot" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES ${placeholders} ON CONFLICT("sku", "warehouseId", "date") DO UPDATE SET ${updateColumns.map((column) => `"${column}" = excluded."${column}"`).join(', ')}`;
      const adapted = adaptSql(sql, values);
      statements.push(prisma.$executeRawUnsafe(adapted.sql, ...adapted.params));
    }

    const touchSql = adaptSql(
      'UPDATE "WarehouseStockSnapshot" SET "dataAsOf" = ?, "updatedAt" = ? WHERE "date" = ?',
      [dataAsOf, updatedAt, date]
    );
    statements.push(prisma.$executeRawUnsafe(touchSql.sql, ...touchSql.params));

    await prisma.$transaction(statements, { timeout: 180000 });
    return persistable.length;
  }

  async syncShopeeSingleStore(storeId, origin = 'MANUAL') {
    const timestamp = new Date();
    try {
      const metrics = await shopeeService.fetchLiveShopeeMetrics('', storeId);
      if (!metrics.isRealDataActive) {
        await this.writeLog('SHOPEE_SYNC', 'FAILED', `[${storeId}] ${metrics.message || 'Sinkronisasi katalog Shopee gagal.'}`, timestamp);
        return { success: false, storeId, source: 'Shopee', status: 'Gagal', message: metrics.message, origin };
      }
      const intelligence = await shopeeInsightsService.getMarketplaceInsights({ storeId });
      const metricCount = intelligence.source === 'SHOPEE_API'
        ? await this.persistProductMetrics(metrics.storeId, intelligence.productPerformance)
        : 0;
      // Secondary to the catalog, so its failure must not fail the job (constraint 9).
      const orderSummary = await shopeeService.syncOrderSummaryHistory({ days: 30, storeId }).catch((err) => {
        console.warn(`[Sync] Order summary history unavailable for ${storeId}:`, err.message);
        return { source: 'EMPTY', persisted: 0, message: err.message };
      });
      // Juga sekunder: hanya menyentuh produk yang kategorinya masih kosong, jadi setelah
      // katalog terisi penuh langkah ini praktis tidak berbiaya.
      const categories = await shopeeService.enrichMissingCategories(storeId).catch((err) => {
        console.warn(`[Sync] Category enrichment unavailable for ${storeId}:`, err.message);
        return { updated: 0, attempted: 0 };
      });
      const orderPart = orderSummary.persisted
        ? ` ${orderSummary.persisted} hari ringkasan pesanan tersimpan.`
        : ` Ringkasan pesanan belum tersimpan: ${orderSummary.message || 'sumber tidak tersedia.'}`;
      const categoryPart = categories.updated ? ` ${categories.updated} kategori produk dilengkapi.` : '';
      const storeLabel = metrics.storeName ? `[${metrics.storeName}] ` : `[${metrics.storeId}] `;
      const message = storeLabel + (metricCount
        ? `Katalog disinkronkan bersama ${metricCount} snapshot performa produk.`
        : 'Katalog disinkronkan. Snapshot performa produk belum tersedia dari Seller Center.') + orderPart + categoryPart;
      await this.writeLog('SHOPEE_SYNC', intelligence.source === 'SHOPEE_API' ? 'SUCCESS' : 'DEGRADED', message, timestamp);
      return { success: true, storeId: metrics.storeId, storeName: metrics.storeName, source: 'Shopee', status: intelligence.source === 'SHOPEE_API' ? 'Segar' : 'Tertunda', message, productCount: metrics.products.length, metricCount, orderSummaryDays: orderSummary.persisted, categoriesUpdated: categories.updated, origin };
    } catch (err) {
      await this.writeLog('SHOPEE_SYNC', 'FAILED', `[${storeId}] ${err.message}`, timestamp);
      return { success: false, storeId, source: 'Shopee', status: 'Gagal', message: `Sinkronisasi Shopee gagal: ${err.message}`, origin };
    }
  }

  async syncShopee({ origin = 'MANUAL', storeId = null } = {}) {
    if (storeId) {
      return this.syncShopeeSingleStore(storeId, origin);
    }
    const allSessions = await shopeeService.getAllSessions();
    const activeSessions = allSessions.filter((s) => s.isActive);
    if (!activeSessions.length) {
      const fallback = await shopeeService.getActiveSession();
      if (fallback?.storeId) {
        return this.syncShopeeSingleStore(fallback.storeId, origin);
      }
      return { success: false, source: 'Shopee', status: 'Gagal', message: 'Tidak ada sesi toko Shopee yang aktif.', origin };
    }

    const results = [];
    for (const session of activeSessions) {
      const res = await this.syncShopeeSingleStore(session.storeId, origin);
      results.push(res);
    }
    const successCount = results.filter((r) => r.success).length;
    const totalProducts = results.reduce((acc, r) => acc + (r.productCount || 0), 0);
    const message = `${successCount}/${activeSessions.length} toko Shopee berhasil disinkronkan (${totalProducts} produk).`;
    return {
      success: successCount > 0,
      source: 'Shopee',
      status: successCount === activeSessions.length ? 'Segar' : (successCount ? 'Tertunda' : 'Gagal'),
      message,
      storeResults: results,
      productCount: totalProducts,
      origin,
    };
  }

  async syncAdsSingleStore(storeId, origin = 'MANUAL') {
    const timestamp = new Date();
    try {
      const metrics = await shopeeService.fetchShopeeAdsMetrics({ storeId });
      if (!metrics.success) {
        await this.writeLog('ADS_SYNC', 'FAILED', `[${storeId}] ${metrics.message || 'Sinkronisasi iklan gagal.'}`, timestamp);
        return { success: false, storeId, source: 'Iklan Shopee', status: 'Gagal', message: metrics.message, origin };
      }
      const result = await this.persistAdsSnapshot(metrics);

      // Self-healing riwayat iklan: isi celah beberapa hari terakhir agar grafik tren tetap
      // menyambung meski server sempat mati sehari. Murah — backfill melewati tanggal yang
      // SUDAH tersimpan TANPA memanggil Shopee, jadi saat data mutakhir ini nol permintaan.
      let backfilled = 0;
      try {
        const gap = await this.backfillAdsHistorySingleStore(storeId, { days: 7, overwrite: false });
        backfilled = gap.filled || 0;
      } catch (gapErr) {
        console.warn(`[Sync] Backfill iklan ${storeId} dilewati:`, gapErr.message);
      }

      const message = `[${storeId}] ${result.campaignCount} kampanye iklan disinkronkan${backfilled ? `, ${backfilled} hari riwayat dilengkapi` : ''}. Nilai nominal dinormalisasi dengan pembagi ${metrics.amountDivisor}.`;
      await this.writeLog('ADS_SYNC', 'SUCCESS', message, timestamp);
      return { success: true, storeId, source: 'Iklan Shopee', status: 'Segar', message, campaignCount: result.campaignCount, origin };
    } catch (err) {
      await this.writeLog('ADS_SYNC', 'FAILED', `[${storeId}] ${err.message}`, timestamp);
      return { success: false, storeId, source: 'Iklan Shopee', status: 'Gagal', message: `Sinkronisasi iklan gagal: ${err.message}`, origin };
    }
  }

  async syncAds({ origin = 'MANUAL', storeId = null } = {}) {
    if (storeId) {
      return this.syncAdsSingleStore(storeId, origin);
    }
    const allSessions = await shopeeService.getAllSessions();
    const activeSessions = allSessions.filter((s) => s.isActive);
    if (!activeSessions.length) {
      const fallback = await shopeeService.getActiveSession();
      if (fallback?.storeId) {
        return this.syncAdsSingleStore(fallback.storeId, origin);
      }
      return { success: false, source: 'Iklan Shopee', status: 'Gagal', message: 'Tidak ada sesi toko Shopee yang aktif.', origin };
    }

    const results = [];
    for (const session of activeSessions) {
      const res = await this.syncAdsSingleStore(session.storeId, origin);
      results.push(res);
    }
    const successCount = results.filter((r) => r.success).length;
    const totalCampaigns = results.reduce((acc, r) => acc + (r.campaignCount || 0), 0);
    const message = `${successCount}/${activeSessions.length} toko iklan berhasil disinkronkan (${totalCampaigns} kampanye).`;
    return {
      success: successCount > 0,
      source: 'Iklan Shopee',
      status: successCount === activeSessions.length ? 'Segar' : (successCount ? 'Tertunda' : 'Gagal'),
      message,
      storeResults: results,
      campaignCount: totalCampaigns,
      origin,
    };
  }

  async syncWarehouse({ origin = 'MANUAL', skipLock = false } = {}) {
    if (!skipLock) {
      const locked = await syncLockService.runExclusive(() => this.syncWarehouse({ origin, skipLock: true }));
      if (!locked.acquired) {
        await this.writeLog('WAREHOUSE_SYNC', 'FAILED', locked.error.message);
        return { success: false, source: 'Gudang', status: 'Gagal', message: locked.error.message, code: locked.error.code, origin };
      }
      return locked.value;
    }

    const timestamp = new Date();
    try {
      const reconciliation = await warehouseService.calculateReconciliation();
      const isLive = reconciliation.dataSource === 'WAREHOUSE_API';
      if (!isLive) {
        const errorMsg = reconciliation.message || 'Koneksi PDC Gudang gagal atau data tidak ditemukan.';
        await this.writeLog('WAREHOUSE_SYNC', 'FAILED', errorMsg, timestamp);
        return { success: false, source: 'Gudang', status: 'Gagal', message: errorMsg, origin };
      }
      const snapshotCount = await this.persistWarehouseSnapshots(reconciliation.reconciliationList, reconciliation.dataSource);
      const syncStats = reconciliation.syncStats || null;
      const message = `PDC Gudang disinkronkan (${reconciliation.totalAudited} SKU-gudang) dengan ${reconciliation.discrepanciesCount} selisih stok terhadap Shopee.`;
      const auditMessage = syncStats
        ? `${message} Stats: katalog=${syncStats.catalogProductCount || 0}, varian=${syncStats.variantCount || 0}, baris=${syncStats.persistedCandidateCount || snapshotCount}, ditulis=${syncStats.writtenCount ?? '-'}${syncStats.fullWrite ? ' (tulis penuh)' : ''}, unresolved=${syncStats.unresolvedVariantCount || 0}, gagal=${syncStats.failedVariantCount || 0}.`
        : message;
      await this.writeLog('WAREHOUSE_SYNC', 'SUCCESS', auditMessage, timestamp);
      return {
        success: true,
        source: 'Gudang',
        status: 'Segar',
        message,
        snapshotCount,
        discrepanciesCount: reconciliation.discrepanciesCount,
        syncStats,
        origin,
      };
    } catch (err) {
      await this.writeLog('WAREHOUSE_SYNC', 'FAILED', err.message, timestamp);
      return { success: false, source: 'Gudang', status: 'Gagal', message: `Sinkronisasi gudang gagal: ${err.message}`, origin };
    }
  }

  async syncAll({ origin = 'MANUAL', storeId = null } = {}) {
    const locked = await syncLockService.runExclusive(async () => {
      const startedAt = new Date();
      const shopee = await this.syncShopee({ origin, storeId });
      const ads = await this.syncAds({ origin, storeId });
      const warehouse = await this.syncWarehouse({ origin, skipLock: true });
      const results = [shopee, ads, warehouse];
      const successCount = results.filter((result) => result.success).length;
      const status = successCount === results.length ? 'SUCCESS' : successCount ? 'DEGRADED' : 'FAILED';
      const message = `${successCount}/${results.length} sumber selesai disinkronkan.`;
      await this.writeLog('FULL_SYNC', status, message, startedAt);
      return { success: successCount > 0, status, message, startedAt: startedAt.toISOString(), results };
    });

    if (!locked.acquired) {
      const message = locked.error.message;
      await this.writeLog('FULL_SYNC', 'FAILED', message);
      return { success: false, status: 'FAILED', message, code: locked.error.code, results: [] };
    }

    return locked.value;
  }
}

module.exports = new SyncService();
