const axios = require('axios');
const prisma = require('../utils/prisma');

class WarehouseService {
  constructor() {
    this.loginUrl = process.env.WAREHOUSE_LOGIN_URL || '';
    this.inventoryUrl = process.env.WAREHOUSE_INVENTORY_URL || '';
    this.username = process.env.WAREHOUSE_USERNAME || '';
    this.password = process.env.WAREHOUSE_PASSWORD || '';
    this.loginFrom = process.env.WAREHOUSE_LOGIN_FROM || 'selling';
    this.accessToken = '';
    this.tokenType = 'Bearer';
    this.tokenExpiresAt = 0;
  }

  setWarehouseConfig({ loginUrl, inventoryUrl, username, password, loginFrom }) {
    const nextConfig = {
      loginUrl: loginUrl || '',
      inventoryUrl: inventoryUrl || '',
      username: username || '',
      password: password || '',
      loginFrom: loginFrom || 'selling',
    };
    const changed = Object.entries(nextConfig).some(([key, value]) => this[key] !== value);

    Object.assign(this, nextConfig);
    if (changed) this.clearAccessToken();
    console.log(`[Warehouse Service] Login configuration ${this.isLoginConfigured() ? 'updated' : 'incomplete'}.`);
  }

  isLoginConfigured() {
    return Boolean(this.loginUrl && this.inventoryUrl && this.username && this.password);
  }

  clearAccessToken() {
    this.accessToken = '';
    this.tokenType = 'Bearer';
    this.tokenExpiresAt = 0;
  }

  extractLoginToken(payload, contentType = '') {
    const rawToken = typeof payload === 'string' ? payload.trim() : '';
    if (/text\/html/i.test(contentType) || /^<!doctype|^<html/i.test(rawToken)) {
      const error = new Error('Warehouse login returned HTML instead of an API access token.');
      error.code = 'WAREHOUSE_LOGIN_HTML_RESPONSE';
      throw error;
    }
    const data = payload?.data || payload || {};
    const token = rawToken || data.auth_token || data.authToken || data.access_token || data.accessToken || data.token || data.jwt || '';
    const expiresIn = Number(data.expires_in ?? data.expiresIn ?? 3600);

    if (!token || typeof token !== 'string') {
      const error = new Error('Warehouse login did not return an access token.');
      error.code = 'WAREHOUSE_TOKEN_MISSING';
      throw error;
    }

    return {
      token,
      tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    };
  }

  async login() {
    if (!this.isLoginConfigured()) {
      const error = new Error('Warehouse login configuration is incomplete.');
      error.code = 'WAREHOUSE_LOGIN_NOT_CONFIGURED';
      throw error;
    }

    let response;
    try {
      response = await axios.post(
        this.loginUrl,
        { username: this.username, password: this.password, from: this.loginFrom },
        {
          timeout: 10000,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        }
      );
    } catch (err) {
      err.warehouseStage = 'LOGIN';
      throw err;
    }
    let login;
    try {
      login = this.extractLoginToken(response.data, response.headers['content-type']);
    } catch (err) {
      err.warehouseStage = 'LOGIN';
      throw err;
    }
    this.accessToken = login.token;
    this.tokenType = login.tokenType;
    this.tokenExpiresAt = Date.now() + Math.max(login.expiresIn - 30, 30) * 1000;
    return this.accessToken;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    return this.login();
  }

  toText(value, fallback = '') {
    const candidate = Array.isArray(value)
      ? value.find((entry) => String(entry || '').trim()) || value[0]
      : value;
    const text = candidate === undefined || candidate === null ? '' : String(candidate).trim();
    return text || fallback;
  }

  getFirstAssetId(...candidates) {
    for (const candidate of candidates) {
      const values = Array.isArray(candidate) ? candidate : [candidate];
      const assetId = values.find((value) => value !== undefined && value !== null && String(value).trim());
      if (assetId !== undefined) return String(assetId).trim();
    }
    return '';
  }

  getAssetThumbnailUrl(assetId) {
    if (!assetId || !this.inventoryUrl) return null;
    try {
      const url = new URL('/v1/assets/get', new URL(this.inventoryUrl).origin);
      url.search = new URLSearchParams({ id: assetId, thumbnail: 'true' }).toString();
      return url.toString();
    } catch {
      return null;
    }
  }

  normalizeWarehouseItem(item) {
    const variationName = this.toText(item.variation_name);
    const assetId = this.getFirstAssetId(item.image, item.image_id, item.asset_id, item.product?.image, item.product?.image_id);
    return {
      sku: this.toText(item.sku || item.variation_sku || item.ref_id || item.id),
      name: this.toText(item.name || item.productName || item.product?.name),
      size: this.toText(item.size || (variationName === '_default' ? '' : variationName), '-'),
      color: this.toText(item.color || item.variation_value, '-'),
      totalStock: Number(item.totalStock ?? item.stock_total ?? item.stock_ready ?? item.stock ?? 0),
      reservedStock: Number(item.reservedStock ?? item.stock_pending ?? 0),
      availableStock: Number(item.availableStock ?? item.stock_ready ?? item.stock_total ?? item.stock ?? 0),
      imageUrl: this.getAssetThumbnailUrl(assetId),
      location: item.location || 'WH-MAIN',
      lastUpdated: item.lastUpdated || new Date().toISOString(),
    };
  }

  async fetchAuthenticatedData(url) {
    const request = async () => {
      const token = await this.getAccessToken();
      try {
        return await axios.get(url, {
          timeout: 10000,
          headers: {
            Accept: 'application/json',
            Authorization: `${this.tokenType} ${token}`,
            token,
          },
        });
      } catch (err) {
        if (!err.warehouseStage) err.warehouseStage = 'INVENTORY';
        throw err;
      }
    };

    let response;
    try {
      response = await request();
    } catch (err) {
      if (err.response?.status !== 401 && err.response?.status !== 403) throw err;
      this.clearAccessToken();
      response = await request();
    }

    return response.data;
  }

  async fetchFromWarehouseApi() {
    const responseData = await this.fetchAuthenticatedData(this.inventoryUrl);

    const payload = responseData?.data || responseData || {};
    const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload) ? payload : null;
    if (!Array.isArray(items)) return null;

    return items.map((item) => this.normalizeWarehouseItem(item));
  }

  async deriveFromShopeeProducts() {
    const products = await prisma.shopeeProduct.findMany({ orderBy: { updatedAt: 'desc' } });
    return products.map((product) =>
      this.normalizeWarehouseItem({
        sku: product.sku || product.shopeeItemId,
        name: product.name,
        stock: product.stock,
        location: 'SHOPEE_BASELINE',
      })
    );
  }

  async persistItems(items) {
    if (!items.length) return;

    await prisma.$transaction(
      items
        .filter((item) => item.sku)
        .map((item) =>
          prisma.warehouseItem.upsert({
            where: { sku: item.sku },
            update: {
              name: item.name,
              size: item.size,
              color: item.color,
              totalStock: item.totalStock,
              reservedStock: item.reservedStock,
              availableStock: item.availableStock,
              imageUrl: item.imageUrl,
              location: item.location,
              lastUpdated: new Date(),
            },
            create: {
              sku: item.sku,
              name: item.name,
              size: item.size,
              color: item.color,
              totalStock: item.totalStock,
              reservedStock: item.reservedStock,
              availableStock: item.availableStock,
              imageUrl: item.imageUrl,
              location: item.location,
            },
          })
        )
    );
  }

  async getInventoryLevels() {
    let items = [];
    let source = 'SHOPEE_BASELINE';
    let warehouseApiMessage = '';
    const loginConfigured = this.isLoginConfigured();

    if (loginConfigured) {
      try {
        const apiItems = await this.fetchFromWarehouseApi();
        if (apiItems) {
          items = apiItems;
          source = 'WAREHOUSE_API';
        } else {
          warehouseApiMessage = 'The Warehouse inventory endpoint returned no usable inventory data.';
        }
      } catch (err) {
        const status = err.response?.status;
        const code = err.code;
        const stage = err.warehouseStage === 'LOGIN' ? 'login' : 'inventory';
        console.warn('[Warehouse Service] Authenticated Warehouse API unavailable.', { status, code });
        warehouseApiMessage = code === 'WAREHOUSE_LOGIN_HTML_RESPONSE'
          ? 'The configured Warehouse login URL returned an HTML page, not an API access token.'
          : code === 'WAREHOUSE_TOKEN_MISSING'
            ? 'Warehouse login succeeded but did not return a supported access-token field.'
          : status
            ? `Warehouse ${stage} request returned HTTP ${status}.`
            : `The Warehouse ${stage} endpoint could not be reached.`;
      }
    } else if (this.loginUrl || this.inventoryUrl || this.username || this.password) {
      warehouseApiMessage = 'Warehouse login configuration is incomplete. Set login URL, inventory URL, username, and password in Settings.';
    }

    if (!items.length) {
      items = await this.deriveFromShopeeProducts();
    }

    await this.persistItems(items);

    return {
      status: loginConfigured ? (source === 'WAREHOUSE_API' ? 'ONLINE' : 'UNAVAILABLE') : 'BASELINE',
      dataSource: source,
      warehouseLocation: source === 'WAREHOUSE_API' ? 'Configured Warehouse API' : 'Shopee stock baseline',
      totalSkus: items.length,
      totalPhysicalUnits: items.reduce((acc, item) => acc + item.totalStock, 0),
      totalAvailableUnits: items.reduce((acc, item) => acc + item.availableStock, 0),
      items,
      message: warehouseApiMessage || (items.length ? null : 'No warehouse data yet. Sync Shopee first or configure Warehouse login in Settings.'),
    };
  }

  async calculateReconciliation() {
    const inventory = await this.getInventoryLevels();
    const shopeeProducts = await prisma.shopeeProduct.findMany();
    const shopeeBySku = new Map(shopeeProducts.map((product) => [product.sku, product]));
    const normalizeName = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const shopeeByName = new Map(shopeeProducts.map((product) => [normalizeName(product.name), product]));

    const reconciliationList = inventory.items.map((item) => {
      const normalizedItemName = normalizeName(item.name);
      const shopeeProduct = shopeeBySku.get(item.sku)
        || shopeeByName.get(normalizedItemName)
        || shopeeProducts.find((product) => {
          const normalizedShopeeName = normalizeName(product.name);
          return normalizedItemName.length >= 8 && (normalizedShopeeName.includes(normalizedItemName) || normalizedItemName.includes(normalizedShopeeName));
        });
      const shopeeStock = shopeeProduct?.stock || 0;
      const warehouseStock = item.availableStock;
      const variance = shopeeStock - warehouseStock;
      const status = variance === 0 ? 'MATCHED' : Math.abs(variance) > 5 ? 'CRITICAL' : 'DISCREPANCY';

      return {
        sku: item.sku,
        name: item.name,
        imageUrl: shopeeProduct?.imageUrl || item.imageUrl || null,
        price: shopeeProduct?.price ?? null,
        size: item.size,
        color: item.color,
        totalStock: item.totalStock,
        reservedStock: item.reservedStock,
        warehouseStock,
        shopeeStock,
        location: item.location,
        variance,
        status,
        recommendedAction:
          variance === 0
            ? 'Stock levels are aligned.'
            : variance < 0
              ? `Increase Shopee stock listing by ${Math.abs(variance)} units.`
              : `Decrease Shopee listing by ${variance} units to prevent overselling.`,
      };
    });

    if (reconciliationList.length) {
      await prisma.$transaction(
        reconciliationList.map((row) =>
          prisma.stockReconciliation.create({
            data: {
              sku: row.sku,
              shopeeStock: row.shopeeStock,
              warehouseStock: row.warehouseStock,
              variance: row.variance,
              status: row.status,
            },
          })
        )
      );
    }

    const discrepanciesCount = reconciliationList.filter((row) => row.status !== 'MATCHED').length;

    return {
      totalAudited: reconciliationList.length,
      matchedCount: reconciliationList.length - discrepanciesCount,
      discrepanciesCount,
      reconciliationList,
      dataSource: inventory.dataSource,
      message: inventory.message,
    };
  }
}

module.exports = new WarehouseService();
