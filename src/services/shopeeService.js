const prisma = require('../utils/prisma');
const configService = require('./configService');
const credentialService = require('./credentialService');
const { shopeeRequest } = require('../utils/shopeeHttp');
const { extractCsrfFromCookie, extractCatalogCsrfFromCookie, getShopeeHeaders } = require('../utils/headerGenerator');

// Cookie default tunggal yang SENGAJA dikonfigurasi (dari config.cookieString saat
// startup, atau store terakhir yang disimpan lewat saveSession). INVARIAN: hanya
// diubah oleh setCookie() — TIDAK PERNAH ditulis dari hasil lookup per-request.
// Itu yang dulu bikin race: getActiveSession() menimpanya berdasar storeId yang
// sedang dilihat, sehingga request store lain yang konkuren bisa menyedot cookie
// store tetangga. Sekarang resolusi cookie selalu memakai session per-request.
let configuredCookie = '';
const SHOPEE_HOMEPAGE_ADS_ENDPOINT = 'https://seller.shopee.co.id/api/pas/v1/homepage/query/';
const SHOPEE_PRODUCT_PERFORMANCE_ENDPOINT = 'https://seller.shopee.co.id/api/mydata/v4/product/performance/';
// endpoint_shopee.json -> datacenter_key_metrics. Seller Center's own dashboard endpoint;
// each metric arrives as one { timestamp, value } point per day, so a single call carries
// the whole history rather than only today.
const SHOPEE_KEY_METRICS_ENDPOINT = 'https://seller.shopee.co.id/api/mydata/v3/dashboard/key-metrics/';
// endpoint_shopee.json -> datacenter_order_performance. A separate series from the one
// above: cancellations and refunds, also one point per day.
const SHOPEE_ORDER_PERFORMANCE_ENDPOINT = 'https://seller.shopee.co.id/api/mydata/dashboard/order-performance/';
// Satu-satunya endpoint yang benar-benar mengembalikan kategori produk. Daftar katalog
// (`search_product_list`) TIDAK mengirim field kategori sama sekali — sudah diperiksa
// seluruh kuncinya: id, name, status, cover_image, parent_sku, price_detail, stock_detail,
// promotion, statistics, tag, modify_time, create_time, model_list, ... tanpa satu pun
// bertema kategori. Itu sebabnya seluruh katalog tersimpan sebagai "Uncategorized".
// Endpoint ini per-produk (satu request per item), jadi hanya dipanggil untuk produk yang
// kategorinya memang belum diketahui.
const SHOPEE_PRODUCT_INFO_ENDPOINT = 'https://seller.shopee.co.id/api/v3/product/get_product_info';
const ADS_AMOUNT_DIVISOR = 100000;
const SHOPEE_ORDER_BY = {
  'confirmed_sales.desc': 'confirmed_sales.desc',
  'confirmed_order.desc': 'confirmed_orders.desc',
  'confirmed_orders.desc': 'confirmed_orders.desc',
  'item_views.desc': 'pv.desc',
  'pv.desc': 'pv.desc',
  'conversion_rate.desc': 'confirmed_order_conversion_rate.desc',
  'confirmed_order_conversion_rate.desc': 'confirmed_order_conversion_rate.desc',
  'add_to_cart_rate.desc': 'uv_to_add_to_cart_rate.desc',
  'uv_to_add_to_cart_rate.desc': 'uv_to_add_to_cart_rate.desc',
};

function getJakartaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeRatePercent(value, fallback = 0) {
  const rate = asFiniteNumber(value);
  if (!rate && fallback) return fallback;
  return rate > 0 && rate <= 1 ? rate * 100 : rate;
}

function findCategoryPath(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return [];
  for (const [key, candidate] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (Array.isArray(candidate) && /categor(y|ies).*(path|list)|cat.*path/.test(normalizedKey)) {
      return candidate.filter((item) => item && typeof item === 'object');
    }
  }
  for (const candidate of Object.values(value)) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const path = findCategoryPath(candidate, depth + 1);
      if (path.length) return path;
    }
  }
  return [];
}

function categoryId(category) {
  const value = category?.id ?? category?.category_id ?? category?.catid ?? null;
  return value === null || value === undefined || value === '' ? null : String(value);
}

function getJakartaDayRange() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const currentDayStart = Math.floor(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), -7, 0, 0) / 1000);
  return { startTime: currentDayStart, endTime: currentDayStart + (24 * 60 * 60) - 1 };
}

function getAdsTimeRange(period = 'real_time', customStart = null, customEnd = null) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const currentDayStart = Math.floor(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), -7, 0, 0) / 1000);
  const currentDayEnd = currentDayStart + 86400 - 1;
  const ONE_DAY = 86400;

  if (customStart && customEnd) {
    return {
      period: 'custom',
      startTime: Number(customStart),
      endTime: Number(customEnd),
    };
  }

  switch (period) {
    case 'real_time':
    case 'today':
      return {
        period: 'real_time',
        startTime: currentDayStart,
        endTime: currentDayEnd,
      };
    case 'yesterday':
      return {
        period: 'yesterday',
        startTime: currentDayStart - ONE_DAY,
        endTime: currentDayStart - 1,
      };
    case 'past7days':
      // Verified against Shopee's own Ads dashboard: "last 7 days" is today + 6 prior days.
      return {
        period: 'past7days',
        startTime: currentDayStart - (6 * ONE_DAY),
        endTime: currentDayEnd,
      };
    case 'past30days':
      // Shopee's "1 Bulan Terakhir" filter is actually 32 days (today + 31 prior),
      // not a strict 30 — verified by sweeping window sizes until every metric matched
      // the dashboard exactly (impressions, GMV, checkout count, item sold, ROAS).
      return {
        period: 'past30days',
        startTime: currentDayStart - (31 * ONE_DAY),
        endTime: currentDayEnd,
      };
    default:
      return {
        period: 'real_time',
        startTime: currentDayStart,
        endTime: currentDayEnd,
      };
  }
}

function getPeriodTimeRange(period = 'real_time', customStart = null, customEnd = null) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const currentDayStart = Math.floor(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), -7, 0, 0) / 1000);
  const now = Math.floor(Date.now() / 1000);
  const ONE_DAY = 86400;

  if (customStart && customEnd) {
    return {
      period: 'custom',
      startTime: Number(customStart),
      endTime: Number(customEnd),
    };
  }

  switch (period) {
    case 'real_time':
      return {
        period: 'real_time',
        startTime: currentDayStart,
        endTime: now,
      };
    case 'yesterday':
      return {
        period: 'yesterday',
        startTime: currentDayStart - ONE_DAY,
        endTime: currentDayStart - 1,
      };
    case 'past7days':
      return {
        period: 'past7days',
        startTime: currentDayStart - (7 * ONE_DAY),
        endTime: currentDayStart - 1,
      };
    case 'past30days':
      return {
        period: 'past30days',
        startTime: currentDayStart - (30 * ONE_DAY),
        endTime: currentDayStart - 1,
      };
    default:
      return {
        period: 'real_time',
        startTime: currentDayStart,
        endTime: now,
      };
  }
}

function emptyShopeeState(message = 'Connect your Shopee store in Settings to view real data.', errorCode = 'NOT_CONNECTED') {
  return {
    success: true,
    live: false,
    isRealDataActive: false,
    dataSource: 'EMPTY',
    errorCode,
    message,
    storeName: '',
    storeId: '',
    summary: {
      todayGmv: 0,
      todayOrders: 0,
      conversionRate: 0,
      averageOrderValue: 0,
      activeProductsCount: 0,
      pendingFulfillments: 0,
    },
    products: [],
  };
}

class ShopeeService {
  setCookie(cookie) {
    configuredCookie = cookie || '';
    console.log(`[Shopee Service] Configured default cookie ${configuredCookie ? 'updated' : 'cleared'}.`);
  }

  /**
   * Sumber cookie tunggal untuk semua request keluar. Resolusi per-request penuh —
   * tanpa state global yang bisa bocor antar-store saat sync konkuren. Prioritas:
   *   1. cookie eksplisit dari pemanggil (customCookie)
   *   2. cookie sesi per-request yang sudah di-resolve (session.cookieString) —
   *      untuk storeId tertentu ini cookie store itu; tanpa storeId ini cookie
   *      sesi aktif. Selalu benar untuk store yang diminta.
   *   3. kredensial terpusat yang dikelola admin (ShopeeCredential) — store lalu global
   *   4. default tunggal yang dikonfigurasi (configuredCookie) — HANYA untuk jalur
   *      tanpa storeId. Permintaan store spesifik tidak boleh jatuh ke default global
   *      milik store lain (isolasi), jadi dikembalikan '' bila tak ada sumber sah.
   */
  async _resolveCookie({ customCookie = '', storeId = null, session = null } = {}) {
    if (customCookie) return customCookie;
    if (session?.cookieString) return session.cookieString;

    const managed = await credentialService.resolveCookie(storeId);
    if (managed) return managed;

    return storeId ? '' : (configuredCookie || '');
  }

  async getActiveSession(storeId = null, user = null) {
    if (storeId) {
      const specific = await prisma.storeSession.findUnique({
        where: { storeId: String(storeId) },
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
      });
      if (specific) {
        // Enforce user ownership if user is non-admin
        if (user && user.role !== 'ADMIN' && specific.userId && specific.userId !== user.id) {
          return null;
        }
        return specific;
      }
    }

    const where = { isActive: true };
    if (user && user.role !== 'ADMIN') {
      where.userId = user.id;
    }

    let session = await prisma.storeSession.findFirst({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    if (!session && user && user.role !== 'ADMIN') {
      // Fallback: search for any store belonging to user even if inactive
      session = await prisma.storeSession.findFirst({
        where: { userId: user.id },
        orderBy: { updatedAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
      });
    }

    return session;
  }

  async getAllSessions(user = null) {
    const where = {};
    if (user && user.role !== 'ADMIN') {
      where.userId = user.id;
    }

    const sessions = await prisma.storeSession.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    const counts = await prisma.shopeeProduct.groupBy({
      by: ['storeId'],
      _count: { shopeeItemId: true },
    });
    const countByStore = new Map(counts.map((c) => [c.storeId, c._count.shopeeItemId]));

    return sessions.map((session) => ({
      ...session,
      owner: session.user || null,
      productCount: countByStore.get(session.storeId) || 0,
      cookieConfigured: Boolean(session.cookieString),
      csrfConfigured: Boolean(session.csrfToken),
    }));
  }

  async getSessionById(storeId, user = null) {
    if (!storeId) return null;
    const session = await prisma.storeSession.findUnique({
      where: { storeId: String(storeId) },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });
    if (session && user && user.role !== 'ADMIN' && session.userId && session.userId !== user.id) {
      return null;
    }
    return session;
  }

  async updateSession(storeId, updates = {}) {
    if (!storeId) throw new Error('storeId wajib disertakan.');
    const allowed = ['storeName', 'cookieString', 'userAgent', 'csrfToken', 'isActive', 'userId'];
    const data = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) data[key] = updates[key];
    }
    if (updates.cookieString) {
      const csrf = extractCsrfFromCookie(updates.cookieString);
      if (csrf) data.csrfToken = csrf;
    }

    return prisma.storeSession.update({
      where: { storeId: String(storeId) },
      data,
    });
  }

  async deleteSession(storeId, deleteProducts = true) {
    if (!storeId) throw new Error('storeId wajib disertakan.');
    const id = String(storeId);

    if (deleteProducts) {
      await prisma.$transaction([
        prisma.shopeeListingVariation.deleteMany({ where: { storeId: id } }),
        prisma.shopeeProduct.deleteMany({ where: { storeId: id } }),
        prisma.shopeeOrderSummary.deleteMany({ where: { storeId: id } }),
        prisma.shopeeAdsCampaignSnapshot.deleteMany({ where: { storeId: id } }),
        prisma.shopeeAdsData.deleteMany({ where: { storeId: id } }),
        prisma.productMetricSnapshot.deleteMany({ where: { storeId: id } }),
        prisma.storeSession.delete({ where: { storeId: id } }),
      ]);
    } else {
      await prisma.storeSession.delete({ where: { storeId: id } });
    }
    return { success: true, storeId: id };
  }

  async saveSession({ storeName, storeId, cookieString, userAgent, csrfToken, isActive = true, userId = null }) {
    const session = await prisma.storeSession.upsert({
      where: { storeId },
      update: {
        storeName,
        cookieString,
        userAgent,
        csrfToken,
        isActive,
        lastSyncedAt: new Date(),
        ...(userId ? { userId } : {}),
      },
      create: {
        storeName,
        storeId,
        cookieString,
        userAgent,
        csrfToken,
        isActive,
        ...(userId ? { userId } : {}),
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    this.setCookie(cookieString);
    return session;
  }

  async persistProducts(storeId, products) {
    await prisma.$transaction(
      products.map((product) =>
        prisma.shopeeProduct.upsert({
          where: { shopeeItemId: product.shopeeItemId },
          update: {
            storeId,
            name: product.name || '',
            sku: product.sku || '',
            price: Number(product.price || 0),
            stock: Number(product.stock || 0),
            salesCount: Number(product.salesCount || 0),
            views: Number(product.views || 0),
            addToCart: Number(product.addToCart || 0),
            category: product.category || 'Uncategorized',
            ...(product.l2CategoryId ? { l2CategoryId: product.l2CategoryId } : {}),
            ...(product.l3CategoryId ? { l3CategoryId: product.l3CategoryId } : {}),
            ...(product.l2CategoryName ? { l2CategoryName: product.l2CategoryName } : {}),
            ...(product.l3CategoryName ? { l3CategoryName: product.l3CategoryName } : {}),
            imageUrl: product.imageUrl || null,
            rating: Number(product.rating || 0),
          },
          create: {
            storeId,
            shopeeItemId: product.shopeeItemId,
            name: product.name || '',
            sku: product.sku || '',
            price: Number(product.price || 0),
            stock: Number(product.stock || 0),
            salesCount: Number(product.salesCount || 0),
            views: Number(product.views || 0),
            addToCart: Number(product.addToCart || 0),
            category: product.category || 'Uncategorized',
            l2CategoryId: product.l2CategoryId || null,
            l3CategoryId: product.l3CategoryId || null,
            l2CategoryName: product.l2CategoryName || null,
            l3CategoryName: product.l3CategoryName || null,
            imageUrl: product.imageUrl || null,
            rating: Number(product.rating || 0),
          },
        })
      )
    );

    // Supplementary to the product rows above, so a failure here must not take the
    // catalog sync down with it. The usual causes are operational rather than data
    // problems: a Prisma Client generated before this model existed, or a database the
    // migration has not been applied to yet.
    await this.persistProductVariations(storeId, products).catch((err) => {
      console.warn(
        '[Shopee Service] Variation persistence skipped, products still saved:',
        err.message,
        '- run `npx prisma generate` and `npx prisma migrate deploy` (see prisma/migrations/README.md)'
      );
    });
  }

  /**
   * Per-variation SKU and stock, normalised from `item.model_list` at fetch time.
   *
   * Two things need this. `ShopeeProduct.stock` is one store-wide number, so it cannot
   * be compared meaningfully against per-warehouse stock. And `ShopeeProduct.sku` falls
   * back to the Shopee item id when parent_sku is empty — precisely the case where the
   * real SKU sits at variation level.
   */
  async persistProductVariations(storeId, products) {
    if (!prisma.shopeeListingVariation) {
      throw new Error('Prisma Client has no ShopeeListingVariation model');
    }

    const dataAsOf = new Date();

    for (const product of products) {
      const itemId = product.shopeeItemId;
      if (!itemId) continue;

      const variations = Array.isArray(product.variations) ? product.variations : [];
      const seenModelIds = variations.map((variation) => String(variation.id || '')).filter(Boolean);

      const operations = variations
        .filter((variation) => variation.id)
        .map((variation) => {
          const row = {
            storeId,
            shopeeItemId: itemId,
            shopeeModelId: String(variation.id),
            name: variation.name || '',
            variationSku: String(variation.sku || '').trim(),
            stock: Number(variation.stock || 0),
            soldCount: Number(variation.soldCount || 0),
            dataAsOf,
          };
          return prisma.shopeeListingVariation.upsert({
            where: { shopeeItemId_shopeeModelId: { shopeeItemId: itemId, shopeeModelId: row.shopeeModelId } },
            update: row,
            create: row,
          });
        });

      // Drop variations the seller has since removed, so stock totals do not include
      // models that no longer exist.
      operations.push(
        prisma.shopeeListingVariation.deleteMany({
          where: { shopeeItemId: itemId, shopeeModelId: { notIn: seenModelIds.length ? seenModelIds : [''] } },
        })
      );

      await prisma.$transaction(operations);
    }
  }

  /**
   * Kategori satu produk. Respons meletakkannya di `data.product_info`:
   *   category_path:           [100009, 100034, 100167]      (id L1, L2, L3)
   *   category_path_name_list: ['Aksesoris Fashion', ...]     (nama, indeks sejajar)
   *
   * Mengembalikan `null` bila Shopee tidak memberi jalur kategori — pemanggil harus
   * membiarkan nilai lama, bukan menulis 'Uncategorized' menimpa kategori yang sudah benar.
   */
  async fetchProductCategory(itemId, { cookie: customCookie = '', session: knownSession = null } = {}) {
    const session = knownSession || await this.getActiveSession();
    const cookie = await this._resolveCookie({ customCookie, session });
    const csrfToken = extractCsrfFromCookie(cookie);
    if (!cookie || !csrfToken || !itemId) return null;

    const params = new URLSearchParams({
      SPC_CDS: csrfToken,
      SPC_CDS_VER: '2',
      product_id: String(itemId),
      is_draft: 'false',
    });

    try {
      const response = await shopeeRequest({ method: 'get', url: `${SHOPEE_PRODUCT_INFO_ENDPOINT}?${params}`,
        headers: getShopeeHeaders(cookie, csrfToken, session?.userAgent),
        timeout: 15000,
      });
      const info = response.data?.data?.product_info;
      if (response.data?.code !== 0 || !info) return null;

      const ids = Array.isArray(info.category_path) ? info.category_path.map(String) : [];
      const names = Array.isArray(info.category_path_name_list) ? info.category_path_name_list.map(String) : [];
      if (!ids.length && !names.length) return null;

      // Jalur kategori Shopee: [L1, L2, L3]. Kolom l2/l3 di ShopeeProduct memakai konvensi
      // yang sama dengan yang dipakai endpoint kompetitor (l2catid/l3catid).
      return {
        category: names[0] || 'Uncategorized',
        l2CategoryId: ids[1] || null,
        l3CategoryId: ids[2] || null,
        l2CategoryName: names[1] || null,
        l3CategoryName: names[2] || null,
        categoryPath: ids,
        categoryPathNames: names,
      };
    } catch (err) {
      console.warn(`[Shopee Service] Kategori produk ${itemId} tidak dapat diambil:`, err.message);
      return null;
    }
  }

  /**
   * Melengkapi kategori produk yang masih kosong. Satu request per produk, jadi dibatasi:
   * hanya produk tanpa kategori yang diproses, dengan konkurensi kecil supaya tidak
   * membanjiri Seller Center. Sekali terisi, produk itu tidak diambil lagi pada sync
   * berikutnya.
   */
  async enrichMissingCategories({ limit = 200, concurrency = 4, storeId = null } = {}) {
    const session = await this.getActiveSession(storeId);
    if (!session?.storeId) return { updated: 0, attempted: 0, message: 'Tidak ada sesi toko aktif.' };

    const pending = await prisma.shopeeProduct.findMany({
      where: {
        storeId: session.storeId,
        OR: [{ category: 'Uncategorized' }, { category: '' }, { l2CategoryId: null }],
      },
      select: { shopeeItemId: true },
      take: Math.max(1, Number(limit) || 200),
    });
    if (!pending.length) return { updated: 0, attempted: 0, message: null };

    let updated = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor];
        cursor += 1;
        const category = await this.fetchProductCategory(item.shopeeItemId, { session });
        if (!category) continue;
        await prisma.shopeeProduct.update({
          where: { shopeeItemId: item.shopeeItemId },
          data: {
            category: category.category,
            l2CategoryId: category.l2CategoryId,
            l3CategoryId: category.l3CategoryId,
            l2CategoryName: category.l2CategoryName,
            l3CategoryName: category.l3CategoryName,
          },
        }).catch((err) => console.warn(`[Shopee Service] Gagal menyimpan kategori ${item.shopeeItemId}:`, err.message));
        updated += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

    return {
      updated,
      attempted: pending.length,
      message: updated ? null : 'Seller Center tidak mengembalikan kategori untuk produk yang diperiksa.',
    };
  }

  async persistOrderSummary(storeId, summary) {
    const today = getJakartaDateKey();
    await prisma.shopeeOrderSummary.upsert({
      where: { storeId_date: { storeId, date: today } },
      update: {
        gmv: summary.todayGmv,
        orderCount: summary.todayOrders,
        conversionRate: summary.conversionRate,
        averageOrderValue: summary.averageOrderValue,
      },
      create: {
        storeId,
        date: today,
        gmv: summary.todayGmv,
        orderCount: summary.todayOrders,
        conversionRate: summary.conversionRate,
        averageOrderValue: summary.averageOrderValue,
      },
    });
  }

  async fetchOrderSummary(cookie, session) {
    const config = await configService.getAll();
    if (!config.shopeeOrderSummaryUrl) return null;

    const response = await shopeeRequest({ method: 'get', url: config.shopeeOrderSummaryUrl,
      headers: getShopeeHeaders(cookie, session?.csrfToken, session?.userAgent),
      timeout: 10000,
    });
    const data = response.data?.data || response.data || {};
    const gmv = Number(data.gmv ?? data.total_gmv ?? data.sales ?? 0);
    const orderCount = Number(data.orderCount ?? data.order_count ?? data.orders ?? 0);
    const conversionRate = Number(data.conversionRate ?? data.conversion_rate ?? 0);
    const averageOrderValue = Number(data.averageOrderValue ?? data.average_order_value ?? (orderCount ? gmv / orderCount : 0));

    if (!Number.isFinite(gmv) || !Number.isFinite(orderCount)) return null;
    return { todayGmv: gmv, todayOrders: orderCount, conversionRate, averageOrderValue };
  }

  /**
   * Daily order summary straight from Seller Center's own dashboard endpoint, which
   * removes the need for the separately configured `shopeeOrderSummaryUrl`.
   *
   * Two properties make it usable as history: every metric carries one point per day, so
   * a single call backfills the whole window, and the running day is not included — no
   * row here is a partial figure.
   *
   * The `confirmed_*` series is used because every other surface in this app reports
   * confirmed orders; mixing in `paid_*` would make the dashboard disagree with itself.
   */
  /**
   * Fetches real-time key metrics for today (GMV, orders, conversion rate, AOV).
   */
  async fetchOrderSummaryRealtime({ cookie: customCookie = '', storeId = null } = {}) {
    const session = await this.getActiveSession(storeId);
    const cookie = await this._resolveCookie({ customCookie, storeId, session });
    const csrfToken = extractCsrfFromCookie(cookie);
    if (!cookie || !csrfToken) {
      return { source: 'EMPTY', row: null, message: 'Simpan cookie Shopee yang valid di Pengaturan.' };
    }

    const endTime = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      SPC_CDS: csrfToken,
      SPC_CDS_VER: '2',
      start_time: String(endTime - 86400),
      end_time: String(endTime),
      period: 'real_time',
      fetag: 'datacenter_overview',
    });

    try {
      const response = await shopeeRequest({ method: 'get', url: `${SHOPEE_KEY_METRICS_ENDPOINT}?${params}`,
        headers: getShopeeHeaders(cookie, csrfToken, session?.userAgent),
        timeout: 12000,
      });
      const payload = response.data || {};
      if (payload.code !== 0 || !payload.result) {
        return { source: 'EMPTY', row: null, message: `Seller Center menolak realtime key metrics${payload.msg ? `: ${payload.msg}` : '.'}` };
      }
      const result = payload.result;
      const today = getJakartaDateKey(new Date());
      const gmv = asFiniteNumber(result.confirmed_gmv?.value ?? result.place_gmv?.value);
      const orderCount = Math.round(asFiniteNumber(result.confirmed_orders?.value ?? result.place_orders?.value));
      const averageOrderValue = asFiniteNumber(result.confirmed_sales_per_order?.value ?? result.place_sales_per_order?.value);
      const uv = asFiniteNumber(result.shop_uv?.value);
      const directConversionRate = asFiniteNumber(result.shop_uv_to_confirmed_buyers_rate?.value);
      const conversionRate = directConversionRate > 0 ? directConversionRate : (uv > 0 ? (orderCount / uv) : 0);

      const row = {
        date: today,
        gmv,
        orderCount,
        conversionRate,
        averageOrderValue,
        cancelledOrders: 0,
        cancelledSales: 0,
        returnRefundOrders: 0,
        returnRefundSales: 0,
      };

      return {
        source: 'SHOPEE_API',
        row,
        message: null,
      };
    } catch (err) {
      return {
        source: 'EMPTY',
        row: null,
        message: err.message,
      };
    }
  }

  async fetchOrderSummaryHistory({ days = 30, includeToday = true, cookie: customCookie = '', storeId = null } = {}) {
    const session = await this.getActiveSession(storeId);
    const cookie = await this._resolveCookie({ customCookie, storeId, session });
    const csrfToken = extractCsrfFromCookie(cookie);
    if (!cookie || !csrfToken) {
      return { source: 'EMPTY', rows: [], message: 'Simpan cookie Shopee yang valid di Pengaturan sebelum mengambil ringkasan pesanan.' };
    }

    const safeDays = Math.min(30, Math.max(1, Number(days) || 30));
    const endTime = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      SPC_CDS: csrfToken,
      SPC_CDS_VER: '2',
      start_time: String(endTime - safeDays * 86400),
      end_time: String(endTime),
      period: safeDays <= 7 ? 'past7days' : 'past30days',
      fetag: 'datacenter_overview',
    });

    try {
      const response = await shopeeRequest({ method: 'get', url: `${SHOPEE_KEY_METRICS_ENDPOINT}?${params}`,
        headers: getShopeeHeaders(cookie, csrfToken, session?.userAgent),
        timeout: 15000,
      });
      const payload = response.data || {};
      if (payload.code !== 0 || !payload.result) {
        return { source: 'EMPTY', rows: [], message: `Seller Center menolak permintaan ringkasan pesanan${payload.msg ? `: ${payload.msg}` : '.'}` };
      }
      let rows = this.normalizeKeyMetricSeries(payload.result);

      if (includeToday) {
        const todayKey = getJakartaDateKey(new Date());
        const alreadyHasToday = rows.some((r) => r.date === todayKey);
        if (!alreadyHasToday) {
          const realtimeRes = await this.fetchOrderSummaryRealtime({ cookie, storeId }).catch(() => null);
          if (realtimeRes?.row) {
            rows.push(realtimeRes.row);
            rows.sort((left, right) => left.date.localeCompare(right.date));
          }
        }
      }

      return {
        source: 'SHOPEE_API',
        rows,
        message: rows.length ? null : 'Seller Center tidak mengembalikan titik data harian untuk rentang ini.',
      };
    } catch (err) {
      const status = err.response?.status;
      return {
        source: 'EMPTY',
        rows: [],
        message: status === 401 || status === 403
          ? 'Seller Center menolak sesi ini untuk ringkasan pesanan. Perbarui cookie di Pengaturan.'
          : status
            ? `Ringkasan pesanan Seller Center mengembalikan HTTP ${status}.`
            : err.message,
      };
    }
  }

  normalizeKeyMetricSeries(result) {
    const byDate = new Map();
    const collect = (key, field) => {
      const points = Array.isArray(result?.[key]?.points) ? result[key].points : [];
      for (const point of points) {
        const timestamp = Number(point?.timestamp);
        if (!Number.isFinite(timestamp)) continue;
        const date = getJakartaDateKey(new Date(timestamp * 1000));
        const row = byDate.get(date) || { date };
        row[field] = asFiniteNumber(point.value);
        byDate.set(date, row);
      }
    };
    collect('confirmed_gmv', 'gmv');
    collect('confirmed_orders', 'orderCount');
    collect('confirmed_sales_per_order', 'averageOrderValue');
    collect('shop_uv_to_confirmed_buyers_rate', 'conversionRate');

    return [...byDate.values()]
      .filter((row) => row.gmv !== undefined || row.orderCount !== undefined)
      .map((row) => ({
        date: row.date,
        gmv: asFiniteNumber(row.gmv),
        orderCount: Math.round(asFiniteNumber(row.orderCount)),
        // Shopee sends the rate as a fraction. It is stored as received and normalised on
        // read, the same way the ads snapshot handles its rates.
        conversionRate: asFiniteNumber(row.conversionRate),
        averageOrderValue: asFiniteNumber(row.averageOrderValue),
      }))
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  /**
   * Cancellations and refunds per day. Shopee reports them as absolute counts and values;
   * it does not publish the denominator it uses for a cancellation *rate*, so none is
   * derived here — the figures stay as measured.
   */
  async fetchOrderPerformanceHistory({ days = 30, cookie: customCookie = '', storeId = null } = {}) {
    const session = await this.getActiveSession(storeId);
    const cookie = await this._resolveCookie({ customCookie, storeId, session });
    const csrfToken = extractCsrfFromCookie(cookie);
    if (!cookie || !csrfToken) return { source: 'EMPTY', rows: [], message: 'Sesi Shopee tidak tersedia.' };

    const safeDays = Math.min(30, Math.max(1, Number(days) || 30));
    const endTime = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      SPC_CDS: csrfToken,
      SPC_CDS_VER: '2',
      start_time: String(endTime - safeDays * 86400),
      end_time: String(endTime),
      period: safeDays <= 7 ? 'past7days' : 'past30days',
      order_type: 'confirmed',
    });

    try {
      const response = await shopeeRequest({ method: 'get', url: `${SHOPEE_ORDER_PERFORMANCE_ENDPOINT}?${params}`,
        headers: getShopeeHeaders(cookie, csrfToken, session?.userAgent),
        timeout: 15000,
      });
      const payload = response.data || {};
      if (payload.code !== 0 || !payload.result) {
        return { source: 'EMPTY', rows: [], message: `Seller Center menolak permintaan performa pesanan${payload.msg ? `: ${payload.msg}` : '.'}` };
      }

      const byDate = new Map();
      const collect = (key, field) => {
        const points = Array.isArray(payload.result?.[key]?.points) ? payload.result[key].points : [];
        for (const point of points) {
          const timestamp = Number(point?.timestamp);
          if (!Number.isFinite(timestamp)) continue;
          const date = getJakartaDateKey(new Date(timestamp * 1000));
          const row = byDate.get(date) || { date };
          row[field] = asFiniteNumber(point.value);
          byDate.set(date, row);
        }
      };
      collect('cancelled_orders', 'cancelledOrders');
      collect('cancelled_sales', 'cancelledSales');
      collect('return_refund_orders', 'returnRefundOrders');
      collect('return_refund_sales', 'returnRefundSales');

      return {
        source: 'SHOPEE_API',
        rows: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
        message: null,
      };
    } catch (err) {
      const status = err.response?.status;
      return {
        source: 'EMPTY',
        rows: [],
        message: status ? `Performa pesanan Seller Center mengembalikan HTTP ${status}.` : err.message,
      };
    }
  }

  /**
   * Where the sales came from (endpoint_shopee.json -> datacenter_traffic_sources).
   * Read live: it is a store-level breakdown of a moving window, and nothing else in the
   * app consumes it, so there is no snapshot to keep in step.
   *
   * Ratios are Shopee's own — they are not recomputed here, and they do not sum to 1:
   * paid ads overlap the organic channels.
   */
  async fetchTrafficSources({ days = 6, storeId = null } = {}) {
    const session = await this.getActiveSession(storeId);
    const cookie = await this._resolveCookie({ storeId, session });
    const csrfToken = extractCsrfFromCookie(cookie);
    if (!cookie || !csrfToken) {
      return { source: 'EMPTY', channels: [], message: 'Simpan cookie Shopee yang valid di Pengaturan untuk melihat sumber kunjungan.' };
    }

    const safeDays = Math.min(30, Math.max(1, Number(days) || 7));
    const endTime = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      SPC_CDS: csrfToken,
      SPC_CDS_VER: '2',
      start_time: String(endTime - safeDays * 86400),
      end_time: String(endTime),
      period: safeDays <= 7 ? 'past7days' : 'past30days',
      order_type: 'confirmed',
    });

    try {
      const response = await shopeeRequest({ method: 'get', url: `https://seller.shopee.co.id/api/mydata/v1/dashboard/traffic-sources/?${params}`,
        headers: getShopeeHeaders(cookie, csrfToken, session?.userAgent),
        timeout: 15000,
      });
      const payload = response.data || {};
      const overview = payload.result?.overview;
      if (payload.code !== 0 || !overview) {
        return { source: 'EMPTY', channels: [], message: `Seller Center menolak permintaan sumber kunjungan${payload.msg ? `: ${payload.msg}` : '.'}` };
      }

      const definitions = [
        { key: 'product_card', label: 'Kartu produk / pencarian' },
        { key: 'live', label: 'Shopee Live' },
        { key: 'video', label: 'Video' },
        { key: 'affiliate', label: 'Afiliasi' },
        { key: 'paid_ads', label: 'Iklan berbayar' },
      ];

      return {
        source: 'SHOPEE_API',
        days: safeDays,
        dataAsOf: new Date().toISOString(),
        totalSales: asFiniteNumber(overview.total_sales),
        channels: definitions
          .filter((definition) => overview[definition.key] !== undefined)
          .map((definition) => ({
            key: definition.key,
            label: definition.label,
            sales: asFiniteNumber(overview[definition.key]),
            // Shopee's own share, kept as a fraction; paid ads overlap the others.
            ratio: Number.isFinite(Number(overview[`${definition.key}_ratio`])) ? Number(overview[`${definition.key}_ratio`]) : null,
            changeRatio: Number.isFinite(Number(overview[`${definition.key}_pct_diff`])) ? Number(overview[`${definition.key}_pct_diff`]) : null,
          })),
        message: null,
      };
    } catch (err) {
      const status = err.response?.status;
      return {
        source: 'EMPTY',
        channels: [],
        message: status === 401 || status === 403
          ? 'Seller Center menolak sesi ini untuk data sumber kunjungan.'
          : status ? `Sumber kunjungan Seller Center mengembalikan HTTP ${status}.` : err.message,
      };
    }
  }

  async persistOrderSummaryHistory(storeId, rows = []) {
    if (!storeId || !rows.length) return 0;
    let written = 0;
    for (const row of rows) {
      const data = {
        gmv: row.gmv,
        orderCount: row.orderCount,
        conversionRate: row.conversionRate,
        averageOrderValue: row.averageOrderValue,
      };
      // Only write cancellation figures for days the series actually covered. Undefined
      // leaves the stored value alone rather than overwriting it with a zero.
      for (const field of ['cancelledOrders', 'cancelledSales', 'returnRefundOrders', 'returnRefundSales']) {
        if (row[field] !== undefined) data[field] = row[field];
      }
      await prisma.shopeeOrderSummary.upsert({
        where: { storeId_date: { storeId, date: row.date } },
        update: data,
        create: { storeId, date: row.date, ...data },
      });
      written += 1;
    }
    return written;
  }

  async syncOrderSummaryHistory({ days = 30, storeId = null } = {}) {
    const session = await this.getActiveSession(storeId);
    if (!session?.storeId) {
      return { source: 'EMPTY', persisted: 0, message: 'Tidak ada sesi toko aktif untuk menyimpan ringkasan pesanan.' };
    }
    const [summary, performance] = await Promise.all([
      this.fetchOrderSummaryHistory({ days, storeId: session.storeId }),
      // Secondary to the GMV series: a failure here must leave the summary intact, so the
      // days simply keep their existing (possibly null) cancellation figures.
      this.fetchOrderPerformanceHistory({ days, storeId: session.storeId }).catch((err) => ({ source: 'EMPTY', rows: [], message: err.message })),
    ]);

    const performanceByDate = new Map(performance.rows.map((row) => [row.date, row]));
    const merged = summary.rows.map((row) => ({ ...row, ...(performanceByDate.get(row.date) || {}) }));
    const persisted = await this.persistOrderSummaryHistory(session.storeId, merged);

    return {
      source: summary.source,
      persisted,
      cancellationDays: performance.rows.length,
      message: summary.message,
      cancellationMessage: performance.message,
    };
  }

  async fetchLiveShopeeMetrics(customCookie = '', storeId = null) {
    const session = await this.getActiveSession(storeId);
    const cookie = await this._resolveCookie({ customCookie, storeId, session });

    if (!cookie) {
      return emptyShopeeState();
    }

    const csrfToken = extractCsrfFromCookie(cookie);
    const catalogCsrfToken = extractCatalogCsrfFromCookie(cookie) || csrfToken;
    if (!catalogCsrfToken) {
      return emptyShopeeState(
        'The Shopee cookie is missing a CSRF token. Include CTOKEN or SPC_CDS and try again.',
        'MISSING_CSRF_TOKEN'
      );
    }
    const searchParams = new URLSearchParams({
      SPC_CDS: catalogCsrfToken,
      SPC_CDS_VER: '2',
      page_size: '48',
      list_type: 'live_all',
      request_attribute: '',
      operation_sort_by: 'recommend_v4',
      need_ads: 'true',
    });
    const searchProductUrl = `https://seller.shopee.co.id/api/v3/opt/mpsku/list/v2/search_product_list?${searchParams.toString()}`;

    try {
      const headers = {
        ...getShopeeHeaders(cookie, catalogCsrfToken, session?.userAgent),
        Referer: 'https://seller.shopee.co.id/portal/product/list/all',
      };

      const rawProductsById = new Map();
      let nextCursor = '';
      let pageInfo = {};
      let pageCount = 0;
      let expectedProductCount = 0;

      // Seller Center uses a cursor chain for this endpoint; page/offset are ignored.
      do {
        const pageUrl = new URL(searchProductUrl);
        if (nextCursor) pageUrl.searchParams.set('cursor', nextCursor);
        const res = await shopeeRequest({ method: 'get', url: pageUrl.toString(), headers, timeout: 10000 });

        if (!res.data || res.data.code !== 0 || !Array.isArray(res.data.data?.products)) {
          return emptyShopeeState('Shopee returned no product data. Check the cookie in Settings.');
        }

        pageInfo = res.data.data.page_info || {};
        expectedProductCount = Number(pageInfo.total) || expectedProductCount;
        for (const product of res.data.data.products) {
          if (product.id !== undefined && product.id !== null) rawProductsById.set(String(product.id), product);
        }

        const previousCursor = nextCursor;
        nextCursor = typeof pageInfo.cursor === 'string' ? pageInfo.cursor : '';
        pageCount += 1;
        if (!nextCursor || nextCursor === previousCursor || pageCount >= 20) break;
      } while (rawProductsById.size < expectedProductCount);

      if (expectedProductCount > 0 && rawProductsById.size < expectedProductCount) {
        const error = new Error(`Shopee catalog pagination incomplete (${rawProductsById.size}/${expectedProductCount}).`);
        error.code = 'INCOMPLETE_CATALOG';
        throw error;
      }

      const rawProducts = Array.from(rawProductsById.values());
      if (!rawProducts.length) {
        return emptyShopeeState('Shopee returned no product data. Check the cookie in Settings.');
      }
      const normalizedProducts = rawProducts
        .map((item) => {
          const categoryPath = Array.isArray(item.category_path) ? item.category_path : findCategoryPath(item);
          const l2Category = categoryPath[1] || categoryPath[0] || null;
          const l3Category = categoryPath[2] || categoryPath[1] || null;
          const priceMin = parseFloat(item.price_detail?.price_min || item.price_detail?.origin_price || 0);
          const displayPrice = Math.round(priceMin);
          const stock = item.stock_detail?.total_available_stock || item.stock_detail?.total_seller_stock || 0;
          const sold = item.statistics?.sold_count || item.sales || 0;
          const imageUrl = item.cover_image
            ? item.cover_image.startsWith('http')
              ? item.cover_image
              : `https://down-id.img.susercontent.com/file/${item.cover_image}`
            : null;

          return {
            shopeeItemId: String(item.id),
            name: item.name || '',
            sku: String(item.parent_sku || item.id),
            price: displayPrice,
            stock,
            salesCount: sold,
            views: item.statistics?.view_count || 0,
            addToCart: item.statistics?.add_to_cart_count || 0,
            category: categoryPath[0]?.display_name || item.category_name || 'Uncategorized',
            l2CategoryId: categoryId(l2Category),
            l3CategoryId: categoryId(l3Category),
            l2CategoryName: l2Category?.display_name || l2Category?.name || null,
            l3CategoryName: l3Category?.display_name || l3Category?.name || null,
            imageUrl,
            rating: Number(item.statistics?.rating_star || 0),
            variations: Array.isArray(item.model_list)
              ? item.model_list.map((model, modelIdx) => ({
                id: String(model.id || ''),
                name: model.name || '',
                sku: model.sku || '',
                stock: model.stock_detail?.total_available_stock || model.stock_detail?.total_seller_stock || 0,
                soldCount: model.statistics?.sold_count || 0,
              }))
              : [],
          };
        });

      if (!session?.storeId) {
        return emptyShopeeState('No active Shopee store session was found. Save a valid cookie in Settings.');
      }

      const storeId = session.storeId;
      const orderSummary = await this.fetchOrderSummary(cookie, session).catch((err) => {
        console.warn('[Shopee Service] Order summary API unavailable:', err.message);
        return null;
      });
      const summary = {
        todayGmv: orderSummary?.todayGmv || 0,
        todayOrders: orderSummary?.todayOrders || 0,
        conversionRate: orderSummary?.conversionRate || 0,
        averageOrderValue: orderSummary?.averageOrderValue || 0,
        activeProductsCount: expectedProductCount || normalizedProducts.length,
        pendingFulfillments: 0,
      };

      await this.persistProducts(storeId, normalizedProducts);
      if (orderSummary) await this.persistOrderSummary(storeId, summary);
      await prisma.storeSession.updateMany({
        where: { storeId },
        data: { lastSyncedAt: new Date(), csrfToken },
      });

      return {
        success: true,
        live: true,
        isRealDataActive: true,
        dataSource: 'LIVE',
        storeName: session?.storeName || 'Shopee Store',
        storeId,
        summary,
        products: normalizedProducts,
        message: orderSummary ? null : 'Product catalog synchronized. Configure an order summary endpoint to collect sales trends.',
      };
    } catch (err) {
      const status = err.response?.status;
      const code = err.code;
      console.warn('[Shopee Service] Catalog sync failed.', { status, code });

      if (status === 401 || status === 403) {
        return emptyShopeeState(
          'Seller Center rejected this session. Refresh the complete Cookie header with CTOKEN (and SPC_CDS when the browser provides it), then sync again.',
          'SESSION_REJECTED'
        );
      }
      if (status === 404 || status === 410) {
        return emptyShopeeState(
          'The Seller Center catalog endpoint is unavailable. Check the integration configuration and try again later.',
          'ENDPOINT_UNAVAILABLE'
        );
      }
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return emptyShopeeState('The Seller Center request timed out. Check your connection and try again.', 'REQUEST_TIMEOUT');
      }
      if (code === 'INCOMPLETE_CATALOG') {
        return emptyShopeeState('Seller Center mengembalikan katalog yang belum lengkap. Jalankan Sync lagi setelah koneksi stabil.', code);
      }

      return emptyShopeeState(
        status ? `Seller Center returned HTTP ${status}; the session could not be validated.` : 'Seller Center could not be reached. Check your connection and try again.',
        status ? `HTTP_${status}` : 'NETWORK_ERROR'
      );
    }
  }

  async getProductById(itemId) {
    const product = await prisma.shopeeProduct.findUnique({ where: { shopeeItemId: String(itemId) } });
    return product || null;
  }

  async fetchShopeeAdsMetrics({ period = 'real_time', startTime: customStart, endTime: customEnd, storeId = null } = {}) {
    const session = await this.getActiveSession(storeId);
    if (!session?.cookieString || !session?.storeId) {
      return {
        success: false,
        dataSource: 'EMPTY',
        message: 'Hubungkan sesi Shopee terlebih dahulu sebelum menyinkronkan iklan.',
        topCampaigns: [],
      };
    }

    try {
      const csrfToken = extractCsrfFromCookie(session.cookieString);
      if (!csrfToken) throw new Error('Sesi Shopee aktif tidak memiliki token CSRF.');
      const { startTime, endTime, period: activePeriod } = getAdsTimeRange(period, customStart, customEnd);
      const query = new URLSearchParams({ SPC_CDS: csrfToken, SPC_CDS_VER: '2' });
      const response = await shopeeRequest({
        method: 'post',
        url: `${SHOPEE_HOMEPAGE_ADS_ENDPOINT}?${query}`,
        data: {
          start_time: startTime,
          end_time: endTime,
          filter_list: [{
            campaign_type: 'product_homepage_v3',
            state: 'all',
            search_term: '',
            is_valid_rebate_only: false,
          }],
          offset: 0,
          limit: 200,
          use_paid_gmv: false,
        },
        headers: {
          ...getShopeeHeaders(session.cookieString, csrfToken, session.userAgent),
          Referer: 'https://seller.shopee.co.id/portal/marketing/ads/homepage',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });
      const envelope = response.data || {};
      if (envelope.code !== 0) throw new Error(envelope.msg || 'Shopee Ads mengembalikan respons yang tidak valid.');
      const rawCampaigns = Array.isArray(envelope.data?.entry_list) ? envelope.data.entry_list : [];
      const campaigns = rawCampaigns.map((campaign) => {
        const report = campaign.report || {};
        const rawSpend = asFiniteNumber(report.cost);
        const rawSales = asFiniteNumber(report.broad_gmv);
        const rawVoucherSpend = asFiniteNumber(report.voucher_amount);
        const rawVoucherSales = asFiniteNumber(report.voucher_sales);
        const rawDailyBudget = asFiniteNumber(campaign.campaign?.daily_budget);
        const impressions = asFiniteNumber(report.impression);
        const clicks = asFiniteNumber(report.click);
        // "Pesanan" on Shopee's own dashboard is the checkout count, not report.order/
        // report.broad_order (which count something broader and don't match the UI total).
        const orders = asFiniteNumber(report.checkout);
        // "Produk Terjual" matches report.broad_order_amount — report.*item_sold fields
        // are unpopulated for this campaign type and always read as 0.
        const itemSold = asFiniteNumber(report.broad_order_amount);
        return {
          id: String(campaign.campaign?.campaign_id || campaign.id || ''),
          name: campaign.title || campaign.name || String(campaign.campaign?.campaign_id || ''),
          type: campaign.type || campaign.subtype || 'Shopee Ads',
          state: campaign.state || 'ongoing',
          rawDailyBudget,
          rawSpend,
          rawSales,
          rawVoucherSpend,
          rawVoucherSales,
          amountDivisor: ADS_AMOUNT_DIVISOR,
          dailyBudget: rawDailyBudget / ADS_AMOUNT_DIVISOR,
          spend: rawSpend / ADS_AMOUNT_DIVISOR,
          sales: rawSales / ADS_AMOUNT_DIVISOR,
          voucherSpend: rawVoucherSpend / ADS_AMOUNT_DIVISOR,
          voucherSales: rawVoucherSales / ADS_AMOUNT_DIVISOR,
          impressions,
          clicks,
          orders,
          itemSold,
          roas: asFiniteNumber(report.broad_roi ?? (rawSpend > 0 ? rawSales / rawSpend : 0)),
          ctr: normalizeRatePercent(report.ctr, impressions > 0 ? (clicks / impressions) * 100 : 0),
        };
      }).filter((campaign) => campaign.id && campaign.name);

      const totals = campaigns.reduce((acc, campaign) => ({
        rawSpend: acc.rawSpend + campaign.rawSpend,
        rawSales: acc.rawSales + campaign.rawSales,
        rawVoucherSpend: acc.rawVoucherSpend + campaign.rawVoucherSpend,
        rawVoucherSales: acc.rawVoucherSales + campaign.rawVoucherSales,
        impressions: acc.impressions + campaign.impressions,
        clicks: acc.clicks + campaign.clicks,
        orders: acc.orders + campaign.orders,
        itemSold: acc.itemSold + campaign.itemSold,
      }), { rawSpend: 0, rawSales: 0, rawVoucherSpend: 0, rawVoucherSales: 0, impressions: 0, clicks: 0, orders: 0, itemSold: 0 });
      const spend = totals.rawSpend / ADS_AMOUNT_DIVISOR;
      const sales = totals.rawSales / ADS_AMOUNT_DIVISOR;

      return {
        success: true,
        storeId: session.storeId,
        totalSpend: spend,
        totalSalesGenerated: sales,
        roas: totals.rawSpend > 0 ? totals.rawSales / totals.rawSpend : 0,
        impressions: totals.impressions,
        clicks: totals.clicks,
        orders: totals.orders,
        itemSold: totals.itemSold,
        ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
        voucherSpend: totals.rawVoucherSpend / ADS_AMOUNT_DIVISOR,
        voucherSales: totals.rawVoucherSales / ADS_AMOUNT_DIVISOR,
        rawSpend: totals.rawSpend,
        rawSales: totals.rawSales,
        rawVoucherSpend: totals.rawVoucherSpend,
        rawVoucherSales: totals.rawVoucherSales,
        amountDivisor: ADS_AMOUNT_DIVISOR,
        topCampaigns: campaigns,
        dataSource: 'SHOPEE_API',
        message: campaigns.length ? null : 'Tidak ada kampanye Product Ads aktif pada periode ini.',
        period: { type: activePeriod, startTime, endTime },
      };
    } catch (err) {
      const status = err.response?.status;
      console.warn('[Shopee Service] Ads sync failed.', { status, code: err.code });
      return {
        success: false,
        dataSource: 'EMPTY',
        message: status === 401 || status === 403
          ? 'Seller Center menolak sesi iklan. Perbarui cookie lalu jalankan Sync lagi.'
          : status ? `Shopee Ads mengembalikan HTTP ${status}.` : 'Shopee Ads tidak dapat dihubungi.',
        topCampaigns: [],
      };
    }
  }

  async fetchProductPerformance({
    period = 'real_time',
    startTime: customStart,
    endTime: customEnd,
    keyword = '',
    categoryType = 'shopee',
    categoryId = '-1',
    pageSize = 10,
    pageNum = 1,
    orderType = 'confirmed',
    orderBy = 'confirmed_sales.desc',
    storeId = null,
  } = {}) {
    const session = await this.getActiveSession(storeId);
    const timeRange = getPeriodTimeRange(period, customStart, customEnd);

    if (!session?.cookieString || !session?.storeId) {
      return {
        success: true,
        live: false,
        isRealDataActive: false,
        dataSource: 'EMPTY',
        storeName: '',
        storeId: '',
        period: timeRange.period,
        startTime: timeRange.startTime,
        endTime: timeRange.endTime,
        total: 0,
        products: [],
        summary: {
          totalSales: 0,
          totalOrders: 0,
          totalUnits: 0,
          totalViews: 0,
          totalVisitors: 0,
          averageConversionRate: 0,
          totalBuyers: 0,
        },
        pagination: {
          page: Number(pageNum),
          pageSize: Number(pageSize),
          total: 0,
          totalPages: 0,
        },
        message: 'Hubungkan sesi Shopee di Pengaturan untuk memuat performa produk real-time.',
      };
    }

    try {
      const csrfToken = extractCsrfFromCookie(session.cookieString);
      if (!csrfToken) throw new Error('Sesi Shopee aktif tidak memiliki token CSRF.');

      const apiOrderBy = SHOPEE_ORDER_BY[orderBy] || 'confirmed_sales.desc';
      const queryParams = new URLSearchParams({
        SPC_CDS: csrfToken,
        SPC_CDS_VER: '2',
        start_time: String(timeRange.startTime),
        end_time: String(timeRange.endTime),
        period: timeRange.period,
        keyword: keyword || '',
        category_type: categoryType || 'shopee',
        category_id: String(categoryId ?? '-1'),
        page_size: String(pageSize || 10),
        page_num: String(pageNum || 1),
        order_type: orderType || 'confirmed',
        order_by: apiOrderBy,
      });

      const url = `${SHOPEE_PRODUCT_PERFORMANCE_ENDPOINT}?${queryParams.toString()}`;
      const response = await shopeeRequest({
        method: 'get',
        url,
        headers: {
          ...getShopeeHeaders(session.cookieString, csrfToken, session.userAgent),
          Referer: 'https://seller.shopee.co.id/portal/datacenter/product/performance',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const envelope = response.data || {};
      if (envelope.code !== 0 && envelope.code !== undefined && envelope.code !== null && envelope.code !== 200) {
        throw new Error(envelope.message || envelope.msg || 'Shopee Product Performance API mengembalikan respons gagal.');
      }

      const dataContainer = envelope.data || envelope.result || {};
      const rawList = Array.isArray(dataContainer.items)
        ? dataContainer.items
        : (Array.isArray(dataContainer.list)
          ? dataContainer.list
          : (Array.isArray(dataContainer.products) ? dataContainer.products : []));
      const totalCount = asFiniteNumber(dataContainer.total ?? dataContainer.total_count ?? rawList.length);

      const catalogProducts = await prisma.shopeeProduct.findMany({
        where: { storeId: session.storeId },
        select: { shopeeItemId: true, sku: true, price: true, imageUrl: true, name: true },
      });
      const catalogById = new Map(catalogProducts.map((product) => [String(product.shopeeItemId), product]));

      const products = rawList.map((item, index) => {
        const itemId = String(item.item_id ?? item.itemid ?? item.id ?? item.model_id ?? '');
        const catalogProduct = catalogById.get(itemId);
        const name = item.item_name || item.name || item.title || catalogProduct?.name || `Produk #${itemId}`;
        let image = item.image || item.image_url || item.pic || '';
        image = image || catalogProduct?.imageUrl || '';
        if (image && !image.startsWith('http') && !image.startsWith('/')) {
          image = `https://down-id.img.susercontent.com/file/${image}`;
        }
        const sku = item.sku || item.item_sku || item.parent_sku || catalogProduct?.sku || '';
        const price = asFiniteNumber(item.price ?? item.current_price ?? item.item_price ?? catalogProduct?.price);

        const confirmedSales = asFiniteNumber(item.confirmed_sales ?? item.sales ?? item.gmv ?? 0);
        const confirmedOrders = asFiniteNumber(item.confirmed_order ?? item.confirmed_orders ?? item.orders ?? 0);
        const confirmedUnits = asFiniteNumber(item.confirmed_units ?? item.units_sold ?? item.item_sold ?? 0);
        const confirmedBuyers = asFiniteNumber(item.confirmed_buyers ?? item.buyers ?? 0);

        const views = asFiniteNumber(item.pv ?? item.item_views ?? item.views ?? item.impressions ?? 0);
        const visitors = asFiniteNumber(item.uv ?? item.item_uv ?? item.unique_visitors ?? 0);

        const addToCartUnits = asFiniteNumber(item.add_to_cart_units ?? item.cart_units ?? 0);
        const addToCartRate = normalizeRatePercent(item.add_to_cart_rate ?? item.uv_to_add_to_cart_rate, visitors > 0 ? (addToCartUnits / visitors) * 100 : 0);
        const conversionRate = normalizeRatePercent(item.conversion_rate ?? item.confirmed_order_conversion_rate, visitors > 0 ? (confirmedOrders / visitors) * 100 : 0);
        const bounceRate = normalizeRatePercent(item.bounce_rate, 0);

        return {
          rank: (Number(pageNum) - 1) * Number(pageSize) + (index + 1),
          itemId,
          name,
          sku,
          image,
          price,
          itemStatus: item.item_status || item.status || 'NORMAL',
          confirmedSales,
          confirmedOrders,
          confirmedUnits,
          confirmedBuyers,
          views,
          visitors,
          addToCartUnits,
          addToCartRate,
          conversionRate,
          bounceRate,
          currency: 'IDR',
          raw: item,
        };
      });

      const rawSummary = dataContainer.summary || {};
      const totalSales = asFiniteNumber(rawSummary.confirmed_sales ?? products.reduce((acc, item) => acc + item.confirmedSales, 0));
      const totalOrders = asFiniteNumber(rawSummary.confirmed_order ?? products.reduce((acc, item) => acc + item.confirmedOrders, 0));
      const totalUnits = asFiniteNumber(rawSummary.confirmed_units ?? products.reduce((acc, item) => acc + item.confirmedUnits, 0));
      const totalViews = asFiniteNumber(rawSummary.item_views ?? products.reduce((acc, item) => acc + item.views, 0));
      const totalVisitors = asFiniteNumber(rawSummary.item_uv ?? products.reduce((acc, item) => acc + item.visitors, 0));
      const totalBuyers = asFiniteNumber(rawSummary.confirmed_buyers ?? products.reduce((acc, item) => acc + item.confirmedBuyers, 0));
      const averageConversionRate = totalVisitors > 0
        ? (totalOrders / totalVisitors) * 100
        : normalizeRatePercent(rawSummary.conversion_rate, 0);

      const parsedPageSize = Number(pageSize) || 10;
      const parsedPageNum = Number(pageNum) || 1;

      return {
        success: true,
        live: true,
        isRealDataActive: true,
        dataSource: 'SHOPEE_API',
        storeName: session.storeName,
        storeId: session.storeId,
        period: timeRange.period,
        startTime: timeRange.startTime,
        endTime: timeRange.endTime,
        total: totalCount,
        products,
        summary: {
          totalSales,
          totalOrders,
          totalUnits,
          totalViews,
          totalVisitors,
          totalBuyers,
          averageConversionRate,
        },
        pagination: {
          page: parsedPageNum,
          pageSize: parsedPageSize,
          total: totalCount,
          totalPages: Math.ceil(totalCount / parsedPageSize) || 1,
        },
        message: null,
      };
    } catch (err) {
      const status = err.response?.status;
      console.warn('[Shopee Service] Product performance fetch failed.', { status, code: err.code, message: err.message });
      return {
        success: false,
        live: false,
        dataSource: 'EMPTY',
        period: timeRange.period,
        startTime: timeRange.startTime,
        endTime: timeRange.endTime,
        total: 0,
        products: [],
        summary: {
          totalSales: 0,
          totalOrders: 0,
          totalUnits: 0,
          totalViews: 0,
          totalVisitors: 0,
          totalBuyers: 0,
          averageConversionRate: 0,
        },
        pagination: {
          page: Number(pageNum),
          pageSize: Number(pageSize),
          total: 0,
          totalPages: 0,
        },
        message: status === 401 || status === 403
          ? 'Seller Center menolak sesi cookie. Silakan perbarui cookie Shopee di Pengaturan.'
          : status ? `Shopee API mengembalikan status HTTP ${status}.` : 'Gagal terhubung ke Shopee Seller Center.',
      };
    }
  }
}

module.exports = new ShopeeService();
