const warehouseService = require('./warehouseService');

const PRODUCT_TYPES = [
  { type: 'priority', teamId: '0', label: 'Priority' },
  { type: 'research', teamId: '57', label: 'Research' },
  { type: 'general', teamId: '0', label: 'General' },
];

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

class WarehouseInsightsService {
  getBaseUrl() {
    if (!warehouseService.inventoryUrl) return '';
    try {
      return new URL(warehouseService.inventoryUrl).origin;
    } catch {
      return '';
    }
  }

  buildProductListUrl(baseUrl, type, teamId) {
    const url = new URL('/v1/products/list_variation', baseUrl);
    url.search = new URLSearchParams({
      page: '1',
      limit: '50',
      type,
      search_by: 'name',
      order_desc: 'true',
      warehouse_id: '0',
      team_id: teamId,
      user_id: '0',
      price_min: '0',
      price_max: '0',
      stock_min: '0',
      stock_max: '0',
      is_ready: 'false',
      only_empty_stock: 'false',
      have_order: 'false',
      ordered: 'false',
      is_locked: 'false',
    }).toString();
    return url.toString();
  }

  buildSoldStatsUrl(baseUrl) {
    const now = Date.now();
    const start = now - (30 * 24 * 60 * 60 * 1000);
    const url = new URL('/v2/products/v2_product_sold', baseUrl);
    url.search = new URLSearchParams({
      domain_id: '63',
      team_id: '63',
      user_id: '0',
      page: '1',
      limit: '50',
      order_desc: 'true',
      search_by: 'name',
      is_locked: 'false',
      cmin: String(start),
      cmax: String(now),
      buyer_team_id: '0',
      buyer_mp_id: '0',
      from: 'selling',
    }).toString();
    return url.toString();
  }

  extractList(payload) {
    const data = payload?.data || payload || [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.data)) return data.data;
    return [];
  }

  normalizeProduct(item, productType) {
    const product = item.product || {};
    const productId = String(item.product_id || product.id || item.id || '');
    const sku = warehouseService.toText(item.sku || item.variation_sku || item.ref_id || item.id);
    return {
      productId,
      sku,
      name: warehouseService.toText(product.name || item.name || item.productName),
      group: productType,
      stockTotal: asNumber(item.stock_total ?? item.stock_ready),
      stockAvailable: asNumber(item.stock_ready ?? item.stock_total),
      stockPending: asNumber(item.stock_pending),
      price: asNumber(item.price_sale_min ?? item.price_min),
      lastOrdered: item.last_ordered || null,
    };
  }

  async getInsights() {
    if (!warehouseService.isLoginConfigured()) {
      return {
        source: 'EMPTY',
        message: 'Configure Warehouse login before loading product intelligence.',
        productGroups: [],
        salesStats: [],
        productSignals: [],
        storeSignals: [],
      };
    }

    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      return {
        source: 'EMPTY',
        message: 'The Warehouse inventory URL is invalid.',
        productGroups: [],
        salesStats: [],
        productSignals: [],
        storeSignals: [],
      };
    }

    try {
      const [groupResponses, soldResponse] = await Promise.all([
        Promise.all(PRODUCT_TYPES.map(async (definition) => ({
          definition,
          payload: await warehouseService.fetchAuthenticatedData(
            this.buildProductListUrl(baseUrl, definition.type, definition.teamId)
          ),
        }))),
        warehouseService.fetchAuthenticatedData(this.buildSoldStatsUrl(baseUrl)),
      ]);

      const salesStats = this.extractList(soldResponse).map((item) => ({
        productId: String(item.product_id || item.product?.id || ''),
        itemSold: asNumber(item.item_sold),
        orderCount: asNumber(item.order_count),
        orderTotal: asNumber(item.order_total),
        buyerTeamCount: asNumber(item.buyer_team_count),
        buyerShopCount: asNumber(item.buyer_shop_count),
      }));
      const salesByProductId = new Map(salesStats.map((item) => [item.productId, item]));
      const productGroups = groupResponses.map(({ definition, payload }) => ({
        type: definition.type,
        label: definition.label,
        products: this.extractList(payload).map((item) => ({
          ...this.normalizeProduct(item, definition.type),
          ...(salesByProductId.get(String(item.product_id || item.product?.id || '')) || {
            itemSold: 0,
            orderCount: 0,
            orderTotal: 0,
            buyerTeamCount: 0,
            buyerShopCount: 0,
          }),
        })),
      }));
      const products = productGroups.flatMap((group) => group.products);

      return {
        source: 'WAREHOUSE_API',
        message: null,
        productGroups,
        salesStats,
        productSignals: this.buildProductSignals(products),
        storeSignals: this.buildStoreSignals(productGroups, salesStats),
      };
    } catch (err) {
      const status = err.response?.status;
      return {
        source: 'EMPTY',
        message: status
          ? `Warehouse intelligence request returned HTTP ${status}.`
          : 'Warehouse intelligence could not be loaded.',
        productGroups: [],
        salesStats: [],
        productSignals: [],
        storeSignals: [],
      };
    }
  }

  buildProductSignals(products) {
    const signals = [];
    const seen = new Set();

    for (const product of products) {
      const key = product.sku || `${product.group}-${product.productId}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      if (product.group === 'priority' && product.stockAvailable <= 10 && product.itemSold > 0) {
        signals.push({
          id: `WAREHOUSE-RESTOCK-${key}`,
          sku: product.sku,
          productName: product.name,
          type: 'RESTOCK_PRIORITY',
          severity: product.stockAvailable <= 3 ? 'HIGH' : 'MEDIUM',
          currentStock: product.stockAvailable,
          soldUnits: product.itemSold,
          impact: `${product.stockAvailable} units available with ${product.itemSold} units sold in the measured period.`,
          actionText: 'Prioritize replenishment before stockout.',
        });
      }

      if (product.stockAvailable >= 50 && product.itemSold === 0) {
        signals.push({
          id: `WAREHOUSE-SLOW-${key}`,
          sku: product.sku,
          productName: product.name,
          type: 'SLOW_MOVING_STOCK',
          severity: 'MEDIUM',
          currentStock: product.stockAvailable,
          soldUnits: 0,
          impact: `${product.stockAvailable} units are available with no recorded sales in the measured period.`,
          actionText: 'Review listing, price, bundle, or promotional placement.',
        });
      }

      if (product.group === 'research' && product.stockAvailable > 0) {
        signals.push({
          id: `WAREHOUSE-RESEARCH-${key}`,
          sku: product.sku,
          productName: product.name,
          type: 'RESEARCH_CANDIDATE',
          severity: 'LOW',
          currentStock: product.stockAvailable,
          soldUnits: product.itemSold,
          impact: `${product.stockAvailable} units are in the research queue.`,
          actionText: 'Validate demand and marketplace positioning before scaling stock.',
        });
      }
    }

    return signals.slice(0, 30);
  }

  buildStoreSignals(productGroups, salesStats) {
    const groupCounts = Object.fromEntries(productGroups.map((group) => [group.type, group.products.length]));
    const totalSold = salesStats.reduce((sum, item) => sum + item.itemSold, 0);
    const totalOrders = salesStats.reduce((sum, item) => sum + item.orderCount, 0);
    const topSeller = [...salesStats].sort((a, b) => b.itemSold - a.itemSold)[0];

    return [
      {
        id: 'WAREHOUSE-STORE-PORTFOLIO',
        title: 'Warehouse portfolio coverage',
        category: 'ASSORTMENT',
        description: `${groupCounts.priority || 0} priority, ${groupCounts.research || 0} research, and ${groupCounts.general || 0} general products were loaded.`,
        impact: 'Use the category split to plan merchandising and replenishment reviews.',
        status: 'LIVE_DATA',
      },
      {
        id: 'WAREHOUSE-STORE-DEMAND',
        title: 'Measured warehouse demand',
        category: 'DEMAND',
        description: `${totalSold} sold units across ${totalOrders} recorded orders in the selected statistics window.`,
        impact: topSeller?.itemSold ? `${topSeller.itemSold} units sold by the leading tracked product.` : 'No sales volume was returned for the statistics window.',
        status: 'LIVE_DATA',
      },
    ];
  }
}

module.exports = new WarehouseInsightsService();
