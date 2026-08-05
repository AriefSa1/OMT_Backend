const axios = require('axios');
const { randomUUID } = require('crypto');
const prisma = require('../utils/prisma');
const {
  ACTIVE_WAREHOUSES,
  ACTIVE_WAREHOUSE_ID_LIST,
  isActiveWarehouseId,
} = require('../constants/warehouseConstants');

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
    this.teamId = null;
    this.teamName = '';
    this.userId = null;
    this.warehousesMap = new Map();
    this.teamsMap = new Map();
    this.lastSyncStats = null;
  }

  async ensureConfigLoaded() {
    if (this.isLoginConfigured()) return;
    try {
      const configs = await prisma.systemConfig.findMany();
      const configMap = Object.fromEntries(configs.map((c) => [c.key, c.value]));
      if (configMap.warehouseLoginUrl && configMap.warehouseUsername && configMap.warehousePassword) {
        this.setWarehouseConfig({
          loginUrl: configMap.warehouseLoginUrl,
          inventoryUrl: configMap.warehouseInventoryUrl,
          username: configMap.warehouseUsername,
          password: configMap.warehousePassword,
          loginFrom: configMap.warehouseLoginFrom,
        });
      }
    } catch (err) {
      console.warn('[Warehouse Service] Failed to load config from database:', err.message);
    }
  }

  setWarehouseConfig({ loginUrl, inventoryUrl, username, password, loginFrom }) {
    const nextConfig = {
      loginUrl: (loginUrl || '').trim(),
      inventoryUrl: (inventoryUrl || '').trim(),
      username: (username || '').trim(),
      password: (password || '').trim(),
      loginFrom: (loginFrom || 'selling').trim(),
    };
    const changed = Object.entries(nextConfig).some(([key, value]) => this[key] !== value);

    Object.assign(this, nextConfig);
    if (changed) this.clearAccessToken();
    console.log(`[Warehouse Service] Login configuration ${this.isLoginConfigured() ? 'updated' : 'incomplete'}.`);
  }

  isLoginConfigured() {
    return Boolean(this.loginUrl && (this.inventoryUrl || this.loginUrl) && this.username && this.password);
  }

  clearAccessToken() {
    this.accessToken = '';
    this.tokenType = 'Bearer';
    this.tokenExpiresAt = 0;
    this.teamId = null;
    this.teamName = '';
    this.userId = null;
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

    const inTeam = Array.isArray(data.in_team) && data.in_team.length > 0 ? data.in_team[0] : null;
    const team = inTeam?.team || data.team || null;
    const teamId = inTeam?.team_id || team?.id || data.team_id || null;
    const teamName = team?.name || inTeam?.alias || '';
    const user = data.user || null;
    const userId = user?.id || inTeam?.user_id || null;

    return {
      token,
      tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
      teamId,
      teamName,
      user,
      userId,
    };
  }

  async login(customCredentials = null) {
    if (!customCredentials) {
      await this.ensureConfigLoaded();
    }
    const loginUrl = customCredentials?.loginUrl || this.loginUrl;
    const username = customCredentials?.username || this.username;
    const password = customCredentials?.password || this.password;
    const loginFrom = customCredentials?.loginFrom || this.loginFrom || 'selling';

    if (!loginUrl || !username || !password) {
      const error = new Error('Warehouse login configuration is incomplete.');
      error.code = 'WAREHOUSE_LOGIN_NOT_CONFIGURED';
      throw error;
    }

    let response;
    try {
      response = await axios.post(
        loginUrl,
        { username, password, from: loginFrom },
        {
          timeout: 15000,
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

    if (!customCredentials) {
      this.accessToken = login.token;
      this.tokenType = login.tokenType;
      this.tokenExpiresAt = Date.now() + Math.max(login.expiresIn - 30, 30) * 1000;
      this.teamId = login.teamId;
      this.teamName = login.teamName;
      this.userId = login.userId;
      return this.accessToken;
    }

    return login;
  }

  async performLogin(customCredentials = null) {
    await this.login(customCredentials);
    return {
      token: this.accessToken,
      tokenType: this.tokenType,
      teamId: this.teamId,
      teamName: this.teamName,
      userId: this.userId,
    };
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    return this.login();
  }

  resolveInventoryUrl(url = this.inventoryUrl, overrideTeamId = null) {
    let target = (url || '').trim();
    if (!target) {
      if (this.loginUrl) {
        try {
          const origin = new URL(this.loginUrl).origin;
          target = `${origin}/v1/products/list`;
        } catch {
          target = 'https://pdcgudang.et.r.appspot.com/v1/products/list';
        }
      } else {
        target = 'https://pdcgudang.et.r.appspot.com/v1/products/list';
      }
    }

    try {
      const parsed = new URL(target);
      if (parsed.pathname === '/' || parsed.pathname === '' || parsed.pathname === '/v1' || parsed.pathname === '/v1/') {
        parsed.pathname = '/v1/products/list';
      }
      const activeTeamId = overrideTeamId || this.teamId;
      if (activeTeamId && !parsed.searchParams.has('team_id')) {
        parsed.searchParams.set('team_id', String(activeTeamId));
      }
      return parsed.toString();
    } catch {
      return target;
    }
  }

  toText(value, fallback = '') {
    const candidate = Array.isArray(value)
      ? value.find((entry) => String(entry || '').trim()) || value[0]
      : value;
    const text = candidate === undefined || candidate === null ? '' : String(candidate).trim();
    return text || fallback;
  }

  formatCategory(category) {
    if (!category) return 'General';
    if (typeof category === 'string') {
      const trimmed = category.trim();
      return trimmed.startsWith('[object') || !trimmed ? 'General' : trimmed;
    }
    if (Array.isArray(category)) {
      const names = category
        .map((c) => {
          if (!c) return '';
          if (typeof c === 'string') return c.trim();
          if (typeof c === 'object') return c.name || c.title || '';
          return String(c);
        })
        .filter((n) => n && !n.startsWith('[object'));
      return names.length > 0 ? names.join(' > ') : 'General';
    }
    if (typeof category === 'object') {
      const name = category.name || category.title;
      return name && !name.startsWith('[object') ? name : 'General';
    }
    return 'General';
  }

  getFirstAssetId(...candidates) {
    for (const candidate of candidates) {
      const values = Array.isArray(candidate) ? candidate : [candidate];
      const assetId = values.find((value) => value !== undefined && value !== null && String(value).trim());
      if (assetId !== undefined && assetId !== '') return String(assetId).trim();
    }
    return '';
  }

  getAssetThumbnailUrl(assetId) {
    if (!assetId) return null;
    const base = this.inventoryUrl || this.loginUrl || 'https://pdcgudang.et.r.appspot.com';
    try {
      const origin = new URL(base).origin;
      const url = new URL('/v1/assets/get', origin);
      url.search = new URLSearchParams({ id: assetId, thumbnail: 'true' }).toString();
      return url.toString();
    } catch {
      return `https://pdcgudang.et.r.appspot.com/v1/assets/get?id=${assetId}&thumbnail=true`;
    }
  }

  getAssetFullUrl(assetId) {
    if (!assetId) return null;
    const base = this.inventoryUrl || this.loginUrl || 'https://pdcgudang.et.r.appspot.com';
    try {
      const origin = new URL(base).origin;
      const url = new URL('/v1/assets/get', origin);
      url.search = new URLSearchParams({ id: assetId }).toString();
      return url.toString();
    } catch {
      return `https://pdcgudang.et.r.appspot.com/v1/assets/get?id=${assetId}`;
    }
  }

  async fetchAuthenticatedData(url, customToken = null) {
    const request = async () => {
      const token = customToken || await this.getAccessToken();
      try {
        return await axios.get(url, {
          timeout: 15000,
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
      if (!customToken) this.clearAccessToken();
      response = await request();
    }

    return response.data;
  }

  extractPayloadItems(responseData) {
    const payload = responseData?.data || responseData || {};
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.list)) return payload.list;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.skus)) return payload.skus;
    if (Array.isArray(payload.stock)) return payload.stock;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') return [payload];
    return [];
  }

  getWarehouseIdFromSkuEntry(entry) {
    return entry?.gudang_id
      ?? entry?.gudangId
      ?? entry?.gudang?.id
      ?? entry?.warehouse_id
      ?? entry?.warehouseId
      ?? entry?.warehouse?.id
      ?? entry?.warehouse?.warehouse_id
      ?? entry?.warehouse_location?.id
      ?? entry?.warehouse_location?.warehouse_id
      ?? entry?.warehouseLocation?.id
      ?? entry?.rack?.warehouse_id
      ?? entry?.rack?.warehouse?.id
      ?? entry?.location?.warehouse_id
      ?? entry?.location?.warehouse?.id
      ?? null;
  }

  getWarehouseNameFromSkuEntry(entry) {
    return entry?.gudang_name
      || entry?.gudangName
      || entry?.gudang?.name
      || entry?.warehouse_name
      || entry?.warehouseName
      || entry?.warehouse?.name
      || entry?.warehouse_location?.name
      || entry?.warehouseLocation?.name
      || entry?.rack?.warehouse?.name
      || entry?.location?.warehouse?.name
      || null;
  }

  getWarehouseLocationFromSkuEntry(entry) {
    return entry?.rack_name
      || entry?.rackName
      || entry?.rack?.name
      || entry?.rack?.code
      || entry?.location_name
      || entry?.locationName
      || entry?.location?.name
      || entry?.location?.code
      || entry?.warehouse_location
      || entry?.warehouseLocation
      || null;
  }

  getNumberFromObject(source, keys, fallback = 0) {
    for (const key of keys) {
      const value = source?.[key];
      if (value !== undefined && value !== null && value !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return fallback;
  }

  hasObjectValue(source, keys) {
    return keys.some((key) => source?.[key] !== undefined && source?.[key] !== null && source?.[key] !== '');
  }

  normalizeVariantSkuEntry(entry, { variantId, warehouseId, fallbackWarehouse = null, items = [] } = {}) {
    const resolvedWarehouseId = this.getWarehouseIdFromSkuEntry(entry) || warehouseId || fallbackWarehouse?.id || null;
    const readyStockKeys = [
      'stock_ready',
      'stockReady',
      'available_stock',
      'availableStock',
      'stock_available',
      'qty_ready',
      'ready_qty',
      'quantity',
      'qty',
      'stock',
    ];
    const pendingStockKeys = [
      'stock_pending',
      'reserved_stock',
      'reservedStock',
      'booked_stock',
      'hold_stock',
      'pending_qty',
    ];
    const totalStockKeys = [
      'stock_total',
      'totalStock',
      'total_stock',
      'physical_stock',
      'stock_physical',
    ];
    const stockReady = this.getNumberFromObject(entry, readyStockKeys);
    const stockPending = this.getNumberFromObject(entry, pendingStockKeys);
    const reportedStockTotal = this.getNumberFromObject(entry, totalStockKeys);
    const stockTotal = this.hasObjectValue(entry, readyStockKeys) || this.hasObjectValue(entry, pendingStockKeys)
      ? stockReady + stockPending
      : reportedStockTotal;

    return {
      variantId: Number(variantId) || variantId,
      warehouseId: Number(resolvedWarehouseId) || resolvedWarehouseId,
      warehouseName: this.getWarehouseNameFromSkuEntry(entry) || fallbackWarehouse?.name || null,
      warehouseLocation: this.getWarehouseLocationFromSkuEntry(entry) || null,
      sku: this.toText(entry?.sku || entry?.ref_id || entry?.refId || entry?.variation_sku),
      availableStock: stockReady,
      reservedStock: stockPending,
      totalStock: stockTotal,
      raw: entry,
      items,
    };
  }

  async getWarehouseOptionList() {
    return ACTIVE_WAREHOUSES.map((warehouse) => ({ id: warehouse.id, name: warehouse.name }));
  }

  async buildWarehouseStockOptions(items = []) {
    const warehouses = await this.getWarehouseOptionList();
    const stockByWarehouse = new Map();

    for (const entry of items) {
      const normalized = this.normalizeVariantSkuEntry(entry, { items: [] });
      if (!normalized.warehouseId) continue;

      const key = String(normalized.warehouseId);
      const existing = stockByWarehouse.get(key);
      if (existing) {
        existing.availableStock += normalized.availableStock || 0;
        existing.reservedStock += normalized.reservedStock || 0;
        existing.totalStock += normalized.totalStock || 0;
      } else {
        stockByWarehouse.set(key, {
          warehouseId: normalized.warehouseId,
          warehouseName: normalized.warehouseName || `Gudang #${normalized.warehouseId}`,
          availableStock: normalized.availableStock || 0,
          reservedStock: normalized.reservedStock || 0,
          totalStock: normalized.totalStock || 0,
        });
      }
    }

    const options = warehouses.map((warehouse) => {
      const stock = stockByWarehouse.get(String(warehouse.id));
      const totalStock = stock?.totalStock || 0;
      return {
        warehouseId: warehouse.id,
        warehouseName: stock?.warehouseName || warehouse.name || `Gudang #${warehouse.id}`,
        availableStock: stock?.availableStock || 0,
        reservedStock: stock?.reservedStock || 0,
        totalStock,
        disabled: totalStock <= 0,
      };
    });

    return options;
  }

  async getWarehouseLocationById(warehouseId) {
    if (!warehouseId) return null;
    const numericId = Number(warehouseId);
    if (!Number.isFinite(numericId)) return null;

    const cached = this.warehousesMap.get(numericId);
    if (cached) return { id: numericId, name: cached.name || `Gudang #${numericId}` };

    try {
      return await prisma.warehouseLocation.findUnique({ where: { id: numericId } });
    } catch {
      return null;
    }
  }

  async discoverVariantIdBySku({ sku, item = null } = {}) {
    const candidates = [
      sku,
      item?.sku,
      item?.refId,
      item?.name,
    ].map((value) => this.toText(value)).filter(Boolean);

    if (!candidates.length) return null;

    await this.getAccessToken();
    const baseUrl = this.resolveInventoryUrl(this.inventoryUrl);

    for (const candidate of candidates) {
      for (const searchParam of ['ref_id', 'sku', 'search', 'keyword', 'q']) {
        let targetUrl;
        try {
          targetUrl = new URL(baseUrl);
          targetUrl.searchParams.set(searchParam, candidate);
          targetUrl.searchParams.set('limit', '20');
          targetUrl.searchParams.set('page', '1');
        } catch {
          continue;
        }

        try {
          const responseData = await this.fetchAuthenticatedData(targetUrl.toString());
          const products = this.extractPayloadItems(responseData);
          for (const product of products) {
            const variations = Array.isArray(product?.variation_values) ? product.variation_values : [];
            for (const variation of variations) {
              const refs = [
                variation?.ref_id,
                variation?.sku,
                variation?.variation_sku,
                variation?.id,
              ].map((value) => this.toText(value)).filter(Boolean);
              if (refs.some((ref) => candidates.includes(ref))) {
                return variation.id || variation.variant_id || variation.variantId || null;
              }
            }
          }
        } catch (err) {
          console.warn('[Warehouse Service] Failed to discover variant id:', err.message);
          return null;
        }
      }
    }

    return null;
  }

  async fetchVariantSkuDetail({ variantId, warehouseId } = {}) {
    if (!variantId) return null;

    const items = await this.fetchVariantSkuEntries(variantId);
    const [fallbackWarehouse, warehouseStockOptions] = await Promise.all([
      this.getWarehouseLocationById(warehouseId),
      this.buildWarehouseStockOptions(items),
    ]);
    const selected = warehouseId
      ? isActiveWarehouseId(warehouseId)
        ? items.find((entry) => String(this.getWarehouseIdFromSkuEntry(entry) || '') === String(warehouseId))
        : null
      : items.find((entry) => isActiveWarehouseId(this.getWarehouseIdFromSkuEntry(entry))) || null;

    if (!selected) {
      const emptyEntry = {};
      return {
        ...this.normalizeVariantSkuEntry(emptyEntry, { variantId, warehouseId, fallbackWarehouse, items }),
        availableStock: 0,
        reservedStock: 0,
        totalStock: 0,
        noWarehouseMatch: Boolean(warehouseId),
        warehouseStockOptions,
        raw: items,
      };
    }

    return {
      ...this.normalizeVariantSkuEntry(selected, { variantId, warehouseId, fallbackWarehouse, items }),
      warehouseStockOptions,
    };
  }

  async fetchVariantSkuEntries(variantId) {
    if (!variantId) return [];

    await this.getAccessToken();
    let origin = 'https://pdcgudang.et.r.appspot.com';
    try {
      origin = new URL(this.inventoryUrl || this.loginUrl || origin).origin;
    } catch {}

    const url = new URL('/v1/products/variants/list_sku', origin);
    url.searchParams.set('variant_id', String(variantId));
    const responseData = await this.fetchAuthenticatedData(url.toString());
    return this.extractPayloadItems(responseData);
  }

  async fetchWarehousesList() {
    try {
      const origin = new URL(this.loginUrl || 'https://pdcgudang.et.r.appspot.com').origin;
      const url = `${origin}/v1/warehouses/list`;
      const res = await this.fetchAuthenticatedData(url);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];

      for (const wh of list) {
        if (wh.id) {
          this.warehousesMap.set(wh.id, wh);
          await prisma.warehouseLocation.upsert({
            where: { id: wh.id },
            update: {
              name: wh.name || `Gudang #${wh.id}`,
              code: wh.code || null,
              ownerName: wh.user_owner?.name || null,
              ownerEmail: wh.user_owner?.email || null,
              teamId: wh.team_id || null,
              racksCount: Array.isArray(wh.racks) ? wh.racks.length : 0,
              racks: Array.isArray(wh.racks) ? JSON.stringify(wh.racks) : null,
              lastUpdated: new Date(),
            },
            create: {
              id: wh.id,
              name: wh.name || `Gudang #${wh.id}`,
              code: wh.code || null,
              ownerName: wh.user_owner?.name || null,
              ownerEmail: wh.user_owner?.email || null,
              teamId: wh.team_id || null,
              racksCount: Array.isArray(wh.racks) ? wh.racks.length : 0,
              racks: Array.isArray(wh.racks) ? JSON.stringify(wh.racks) : null,
            },
          });
        }
      }
      return list;
    } catch (err) {
      console.warn('[Warehouse Service] Failed to fetch warehouses list:', err.message);
      return [];
    }
  }

  async fetchTeamsMap() {
    try {
      const origin = new URL(this.loginUrl || 'https://pdcgudang.et.r.appspot.com').origin;
      const url = `${origin}/v1/teams/list?limit=200`;
      const res = await this.fetchAuthenticatedData(url);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];

      for (const t of list) {
        if (t.id) {
          this.teamsMap.set(t.id, t);
        }
      }
      return this.teamsMap;
    } catch (err) {
      console.warn('[Warehouse Service] Failed to fetch teams list:', err.message);
      return this.teamsMap;
    }
  }

  determineProductType(prod, team = null) {
    if (Boolean(prod?.priority || prod?.isPriority || prod?.is_priority)) {
      return 'priority';
    }

    const ref = String(prod?.ref_id || prod?.sku || '').toUpperCase();
    const name = String(prod?.name || prod?.productName || '').toUpperCase();
    const teamCode = String(team?.team_code || '');
    const teamName = String(team?.name || '').toLowerCase();

    const isResearch =
      teamCode === '00' ||
      teamName.includes('internal') ||
      teamName.includes('riset') ||
      teamName.includes('research') ||
      Boolean(prod?.cross_locked || prod?.isCrossLocked) ||
      ref.startsWith('RS-') ||
      ref.startsWith('RSC-') ||
      ref.includes('RISET') ||
      name.includes('RISET');

    if (isResearch) {
      return 'research';
    }

    return 'general';
  }

  determineProductWarehouse(prod, team = null) {
    const teamId = prod?.team_id || team?.id;

    // Physical warehouse allocation mapping based on PDC Gudang inventory infrastructure
    if (teamId === 40) {
      return { warehouseId: 39, warehouseName: 'Pdc Srengat', warehouseLocation: 'Rak T26-Rak' };
    }
    if (teamId === 88 || teamId === 1) {
      return { warehouseId: 94, warehouseName: 'Palem Warehouse', warehouseLocation: 'Rak 8804A1' };
    }
    if (teamId === 67) {
      return { warehouseId: 67, warehouseName: 'Febri Warehouse', warehouseLocation: 'Rak 67-A1' };
    }
    if (teamId === 92) {
      return { warehouseId: 92, warehouseName: 'LGIS Warehouse', warehouseLocation: 'Rak LGIS-B1' };
    }
    if (teamId === 96) {
      return { warehouseId: 96, warehouseName: 'Cemara Warehouse', warehouseLocation: 'Rak CM-01' };
    }

    // Default primary warehouse center
    const rackCode = team?.team_code ? `Rak ${team.team_code}01A1` : 'PDC Center';
    return { warehouseId: 38, warehouseName: 'PDC Warehouse (Center)', warehouseLocation: rackCode };
  }

  async fetchRecentStockOutOrders(teamId = null) {
    try {
      const activeTeamId = teamId || this.teamId || 63;
      const origin = new URL(this.loginUrl || 'https://pdcgudang.et.r.appspot.com').origin;
      const url = `${origin}/v1/orders/list?team_id=${activeTeamId}&limit=50`;
      const res = await this.fetchAuthenticatedData(url);
      const orders = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];

      const candidates = new Map();
      for (const ord of orders) {
        const orderRef = this.toText(ord.ref_id || ord.id || ord.tracking_number, `ORD-${ord.id}`);
        const mpSource = ord.order_mp?.mp_type ? ord.order_mp.mp_type.toUpperCase() : 'PDC_ORDER';
        const orderDate = ord.timestamp?.[0]?.timestamp || ord.created ? new Date(ord.timestamp?.[0]?.timestamp || ord.created) : new Date();

        if (Array.isArray(ord.order_items)) {
          for (const item of ord.order_items) {
            const sku = this.toText(item.ref_id || item.sku || (item.variation_values && item.variation_values[0]?.ref_id) || item.product?.ref_id || item.id);
            const qty = Number(item.count || item.quantity || 1);
            const productName = this.toText(item.name || item.product?.name, 'Produk Gudang');

            if (!sku) continue;
            const key = `${sku}\u0000${orderRef}`;
            const existingCandidate = candidates.get(key);
            candidates.set(key, {
              sku,
              productId: item.product_id || item.product?.id || null,
              productName,
              type: 'OUT',
              quantity: (existingCandidate?.quantity || 0) + qty,
              reference: orderRef,
              source: mpSource,
              note: `Pesanan keluar status: ${ord.order_status || 'PROCESSED'}`,
              warehouseId: 38,
              warehouseName: 'PDC Warehouse (Center)',
              timestamp: orderDate,
            });
          }
        }
      }

      const rows = Array.from(candidates.values());
      if (!rows.length) return 0;
      const references = [...new Set(rows.map((row) => row.reference))];
      const existingRows = await prisma.stockMovement.findMany({
        where: { type: 'OUT', reference: { in: references } },
        select: { sku: true, reference: true },
      });
      const existingKeys = new Set(existingRows.map((row) => `${row.sku}\u0000${row.reference}`));
      const newRows = rows.filter((row) => !existingKeys.has(`${row.sku}\u0000${row.reference}`));
      if (!newRows.length) return 0;
      const result = await prisma.stockMovement.createMany({ data: newRows });
      return result.count;
    } catch (err) {
      console.warn('[Warehouse Service] Failed to fetch outbound order movements:', err.message);
      return 0;
    }
  }

  async mapWithConcurrency(values, concurrency, handler) {
    const results = new Array(values.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await handler(values[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length || 1) }, worker));
    return results;
  }

  async fetchFromWarehouseApi({ maxPages = 100, limit = 500 } = {}) {
    await this.getAccessToken();
    await Promise.allSettled([this.fetchWarehousesList(), this.fetchTeamsMap()]);

    const resolvedUrl = this.resolveInventoryUrl(this.inventoryUrl);
    if (!resolvedUrl) return null;

    const firstUrl = new URL(resolvedUrl);
    firstUrl.searchParams.set('limit', String(limit));
    firstUrl.searchParams.set('page', '1');
    const firstResponse = await this.fetchAuthenticatedData(firstUrl.toString());
    const allProducts = this.extractPayloadItems(firstResponse);
    const pageInfo = firstResponse?.page_info || firstResponse?.data?.page_info || {};
    const totalPages = Math.min(
      Number(pageInfo.total_pages || pageInfo.total_page || pageInfo.totalPages) || 1,
      maxPages
    );

    if (totalPages > 1) {
      const pages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
      const pageResults = await this.mapWithConcurrency(pages, 10, async (page) => {
        const pageUrl = new URL(resolvedUrl);
        pageUrl.searchParams.set('limit', String(limit));
        pageUrl.searchParams.set('page', String(page));
        try {
          return this.extractPayloadItems(await this.fetchAuthenticatedData(pageUrl.toString()));
        } catch (err) {
          console.warn(`[Warehouse Service] Failed to fetch product page ${page}:`, err.message);
          throw err;
        }
      });
      allProducts.push(...pageResults.flat());
    }

    const records = [];
    for (const prod of allProducts) {
      const variations = Array.isArray(prod?.variation_values) && prod.variation_values.length
        ? prod.variation_values
        : [null];
      const prodAssetId = this.getFirstAssetId(prod?.image, prod?.image_id, prod?.asset_id);
      const teamId = prod?.team_id || this.teamId;
      const teamObj = this.teamsMap.get(teamId) || (this.teamId === teamId ? { id: this.teamId, name: this.teamName } : null);
      const teamName = teamObj?.name || (teamId ? `Team ${teamId}` : 'Team 94');
      const teamCode = teamObj?.team_code || null;
      const productType = this.determineProductType(prod, teamObj);
      const fallbackWarehouse = this.determineProductWarehouse(prod, teamObj);
      const priceMin = Number(prod?.price_min || prod?.price || 0);
      const priceMax = Number(prod?.price_max || prod?.price || priceMin);
      const category = this.formatCategory(prod?.category || prod?.category_name);
      const refId = this.toText(prod?.ref_id);
      const desc = this.toText(prod?.desc || prod?.description);
      const bundleCount = Number(prod?.bundle_count || 0);
      const isPriority = Boolean(prod?.priority || prod?.isPriority || productType === 'priority');
      const isCrossLocked = Boolean(prod?.cross_locked || prod?.isCrossLocked);

      for (const variation of variations) {
        const varName = this.toText(variation?.variation_name);
        const varVal = this.toText(variation?.variation_value);
        const varAssetId = this.getFirstAssetId(variation?.image, variation?.image_id, variation?.asset_id) || prodAssetId;
        const rawVariationId = variation?.id || variation?.variant_id || variation?.variantId || (!variation ? prod?.id : null);
        const sku = this.toText(variation?.ref_id || variation?.sku || prod?.ref_id || variation?.id || prod?.id);
        if (!sku) continue;

        records.push({
          product: prod,
          variation,
          variantId: rawVariationId,
          sku,
          name: this.toText(prod?.name || prod?.productName, 'Produk Gudang'),
          size: varName && varName !== '_default' ? `${varName}: ${varVal}` : varVal || '-',
          color: '-',
          imageUrl: this.getAssetThumbnailUrl(varAssetId),
          teamId,
          teamName,
          teamCode,
          productType,
          priceMin: Number(variation?.price_min || variation?.price || priceMin),
          priceMax: Number(variation?.price_max || variation?.price || priceMax || priceMin),
          category,
          refId: this.toText(variation?.ref_id || refId),
          desc,
          bundleCount: Number(variation?.bundle_count ?? bundleCount),
          isPriority,
          isCrossLocked,
          rawProductId: Number(prod?.id) || null,
          fallbackWarehouse,
          catalogAvailableStock: Number(variation?.stock_ready ?? prod?.stock_ready ?? 0),
          catalogReservedStock: Number(variation?.stock_pending ?? prod?.stock_pending ?? 0),
        });
      }
    }

    const uniqueRecords = Array.from(new Map(
      records.filter((record) => record.variantId).map((record) => [String(record.variantId), record])
    ).values());
    const recordsWithoutVariant = records.filter((record) => !record.variantId);
    const concurrency = Math.max(1, Number(process.env.WAREHOUSE_VARIANT_SYNC_CONCURRENCY) || 8);
    const results = await this.mapWithConcurrency(uniqueRecords, concurrency, async (record) => {
      try {
        const entries = await this.fetchVariantSkuEntries(record.variantId);
        const grouped = new Map();
        for (const entry of entries) {
          const warehouseId = Number(this.getWarehouseIdFromSkuEntry(entry));
          if (!isActiveWarehouseId(warehouseId)) continue;
          const warehouse = ACTIVE_WAREHOUSES.find((candidate) => candidate.id === warehouseId);
          const normalized = this.normalizeVariantSkuEntry(entry, { variantId: record.variantId, warehouseId, fallbackWarehouse: warehouse });
          const sku = normalized.sku || record.sku;
          const key = `${sku}:${warehouseId}`;
          const existing = grouped.get(key);
          if (existing) {
            existing.availableStock += normalized.availableStock;
            existing.reservedStock += normalized.reservedStock;
            existing.totalStock += normalized.totalStock;
          } else {
            grouped.set(key, {
              ...record,
              sku,
              warehouseId,
              warehouseName: warehouse.name,
              warehouseLocation: null,
              location: warehouse.name,
              availableStock: normalized.availableStock,
              reservedStock: normalized.reservedStock,
              totalStock: normalized.totalStock,
              stockSource: 'PDC_VARIANT_API',
              rawVariationId: Number(record.variantId) || null,
              lastUpdated: new Date().toISOString(),
            });
          }
        }

        if (grouped.size) return { items: Array.from(grouped.values()), unresolved: false };

        const fallbackWarehouse = record.fallbackWarehouse;
        if (fallbackWarehouse && isActiveWarehouseId(fallbackWarehouse.warehouseId)) {
          const totalStock = record.catalogAvailableStock + record.catalogReservedStock;
          return {
            items: [{
              ...record,
              warehouseId: fallbackWarehouse.warehouseId,
              warehouseName: ACTIVE_WAREHOUSES.find((warehouse) => warehouse.id === fallbackWarehouse.warehouseId)?.name || fallbackWarehouse.warehouseName,
              warehouseLocation: null,
              location: fallbackWarehouse.warehouseName,
              availableStock: record.catalogAvailableStock,
              reservedStock: record.catalogReservedStock,
              totalStock,
              stockSource: 'TEAM_MAPPING_FALLBACK',
              rawVariationId: Number(record.variantId) || null,
              lastUpdated: new Date().toISOString(),
            }],
            unresolved: true,
          };
        }
        return { items: [], unresolved: true };
      } catch (error) {
        return { error, items: [], unresolved: false };
      }
    });

    const fallbackResults = recordsWithoutVariant.map((record) => {
      const fallbackWarehouse = record.fallbackWarehouse;
      if (!fallbackWarehouse || !isActiveWarehouseId(fallbackWarehouse.warehouseId)) {
        return { items: [], unresolved: true };
      }
      const totalStock = record.catalogAvailableStock + record.catalogReservedStock;
      return {
        items: [{
          ...record,
          warehouseId: fallbackWarehouse.warehouseId,
          warehouseName: ACTIVE_WAREHOUSES.find((warehouse) => warehouse.id === fallbackWarehouse.warehouseId)?.name || fallbackWarehouse.warehouseName,
          warehouseLocation: null,
          location: fallbackWarehouse.warehouseName,
          availableStock: record.catalogAvailableStock,
          reservedStock: record.catalogReservedStock,
          totalStock,
          stockSource: 'TEAM_MAPPING_FALLBACK',
          rawVariationId: null,
          lastUpdated: new Date().toISOString(),
        }],
        unresolved: true,
      };
    });
    const allResults = [...results, ...fallbackResults];

    const failed = allResults.filter((result) => result.error);
    if (failed.length) {
      const error = new Error(`${failed.length} varian gagal diambil dari endpoint list_sku.`);
      error.syncStats = { failedVariantCount: failed.length, variantCount: uniqueRecords.length };
      throw error;
    }

    const items = allResults.flatMap((result) => result.items || []);
    const syncStats = {
      catalogProductCount: allProducts.length,
      variantCount: uniqueRecords.length,
      persistedCandidateCount: items.length,
      unresolvedVariantCount: allResults.filter((result) => result.unresolved).length,
      failedVariantCount: 0,
      activeWarehouseCounts: Object.fromEntries(ACTIVE_WAREHOUSES.map((warehouse) => [warehouse.id, items.filter((item) => item.warehouseId === warehouse.id).length])),
    };

    this.fetchRecentStockOutOrders(this.teamId).catch((err) => {
      console.warn('[Warehouse Service] Background outbound sync error:', err.message);
    });

    return { items, complete: true, syncStats };
  }

  async testConnection(customConfig = null) {
    try {
      const loginResult = await this.performLogin(customConfig);
      const token = loginResult.token;
      const teamId = loginResult.teamId || this.teamId;
      const teamName = loginResult.teamName || this.teamName;
      const user = loginResult.user || null;

      const inventoryUrlInput = customConfig?.inventoryUrl || this.inventoryUrl;
      const resolvedInventoryUrl = this.resolveInventoryUrl(inventoryUrlInput, teamId);

      const targetUrlObj = new URL(resolvedInventoryUrl);
      if (!targetUrlObj.searchParams.has('limit')) targetUrlObj.searchParams.set('limit', '10');
      if (!targetUrlObj.searchParams.has('page')) targetUrlObj.searchParams.set('page', '1');

      const invRes = await this.fetchAuthenticatedData(targetUrlObj.toString(), token);
      const totalItems = invRes?.page_info?.total_items || (Array.isArray(invRes?.data) ? invRes.data.length : 0);
      const previewCount = Array.isArray(invRes?.data) ? invRes.data.length : 0;

      return {
        success: true,
        message: `Koneksi berhasil! Terhubung sebagai ${user?.name || user?.username || 'User'} (${teamName || `Team ID: ${teamId}`}). Total ${totalItems.toLocaleString('id-ID')} item terdeteksi di gudang.`,
        team: { id: teamId, name: teamName },
        user: { id: user?.id, name: user?.name, username: user?.username },
        totalWarehouseItems: totalItems,
        previewItemsCount: previewCount,
        resolvedInventoryUrl,
      };
    } catch (err) {
      const status = err.response?.status;
      const stage = err.warehouseStage === 'LOGIN' ? 'login' : 'inventori';
      let message = err.message;
      if (err.code === 'WAREHOUSE_LOGIN_HTML_RESPONSE') {
        message = 'URL login mengembalikan halaman HTML. Pastikan URL login mengarah ke endpoint API /v1/users/login.';
      } else if (err.code === 'WAREHOUSE_TOKEN_MISSING') {
        message = 'Login berhasil tetapi token otorisasi tidak ditemukan pada respons.';
      } else if (status === 401 || status === 403) {
        message = `Otentikasi gagal (HTTP ${status}). Periksa kembali username, password, atau asal login (selling).`;
      } else if (status === 404) {
        message = `Endpoint ${stage} tidak ditemukan (HTTP 404). Periksa kembali URL yang dimasukkan.`;
      } else if (err.response?.data?.err_msg) {
        message = `Server gudang: ${err.response.data.err_msg}`;
      } else if (err.response?.data?.message) {
        message = `Server gudang: ${err.response.data.message}`;
      }
      return {
        success: false,
        error: message,
        message,
        stage,
      };
    }
  }

  async persistItems(items) {
    const uniqueItemsMap = new Map();
    for (const item of items || []) {
      const warehouseId = Number(item?.warehouseId);
      if (!item?.sku || !isActiveWarehouseId(warehouseId)) continue;
      uniqueItemsMap.set(`${item.sku}:${warehouseId}`, { ...item, warehouseId });
    }
    const uniqueItems = Array.from(uniqueItemsMap.values());

    const now = new Date();
    const dataToInsert = uniqueItems.map((item) => ({
      sku: item.sku,
      name: item.name || 'Produk Gudang',
      size: item.size || '-',
      color: item.color || '-',
      totalStock: Number(item.totalStock || 0),
      reservedStock: Number(item.reservedStock || 0),
      availableStock: Number(item.availableStock || 0),
      imageUrl: item.imageUrl || null,
      location: item.location || item.warehouseName || 'PDC-GUDANG',
      warehouseId: item.warehouseId,
      warehouseName: item.warehouseName || ACTIVE_WAREHOUSES.find((warehouse) => warehouse.id === item.warehouseId)?.name || null,
      warehouseLocation: item.warehouseLocation || null,
      stockSource: item.stockSource || 'WAREHOUSE_API',
      teamId: item.teamId || null,
      teamName: item.teamName || null,
      teamCode: item.teamCode || null,
      productType: item.productType || 'general',
      priceMin: Number(item.priceMin || 0),
      priceMax: Number(item.priceMax || 0),
      category: item.category || 'General',
      refId: item.refId || null,
      desc: item.desc || null,
      bundleCount: Number(item.bundleCount || 0),
      isPriority: Boolean(item.isPriority),
      isCrossLocked: Boolean(item.isCrossLocked),
      rawProductId: item.rawProductId || null,
      rawVariationId: item.rawVariationId || null,
      lastUpdated: now,
    }));

    const previousRows = await prisma.warehouseItem.findMany({
      where: { warehouseId: { in: ACTIVE_WAREHOUSE_ID_LIST } },
      select: { id: true, sku: true, warehouseId: true },
    });
    if (previousRows.length >= 20 && dataToInsert.length < Math.ceil(previousRows.length * 0.7)) {
      const error = new Error(`Snapshot gudang tampak tidak lengkap (${dataToInsert.length} dari ${previousRows.length} SKU tersimpan). Data lama dipertahankan.`);
      error.code = 'WAREHOUSE_PARTIAL_SNAPSHOT';
      throw error;
    }

    const previousByKey = new Map(previousRows.map((row) => [`${row.sku}:${row.warehouseId}`, row]));
    const incomingKeys = new Set(dataToInsert.map((row) => `${row.sku}:${row.warehouseId}`));
    const staleIds = previousRows.filter((row) => !incomingKeys.has(`${row.sku}:${row.warehouseId}`)).map((row) => row.id);
    const columns = [
      'id', 'sku', 'name', 'size', 'color', 'totalStock', 'reservedStock', 'availableStock',
      'imageUrl', 'location', 'warehouseId', 'warehouseName', 'warehouseLocation', 'stockSource',
      'teamId', 'teamName', 'teamCode', 'productType', 'priceMin', 'priceMax', 'category', 'refId',
      'desc', 'bundleCount', 'isPriority', 'isCrossLocked', 'rawProductId', 'rawVariationId', 'lastUpdated',
    ];
    const updateColumns = columns.filter((column) => !['id', 'sku', 'warehouseId'].includes(column));

    await prisma.$transaction(async (tx) => {
      const chunkSize = 100;
      for (let i = 0; i < dataToInsert.length; i += chunkSize) {
        const chunk = dataToInsert.slice(i, i + chunkSize).map((row) => ({
          id: previousByKey.get(`${row.sku}:${row.warehouseId}`)?.id || randomUUID(),
          ...row,
        }));
        const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
        const values = chunk.flatMap((row) => columns.map((column) => row[column]));
        const sql = `INSERT INTO "WarehouseItem" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES ${placeholders} ON CONFLICT("sku", "warehouseId") DO UPDATE SET ${updateColumns.map((column) => `"${column}" = excluded."${column}"`).join(', ')}`;
        await tx.$executeRawUnsafe(sql, ...values);
      }
      for (let i = 0; i < staleIds.length; i += 500) {
        await tx.warehouseItem.deleteMany({ where: { id: { in: staleIds.slice(i, i + 500) } } });
      }
    }, { maxWait: 30000, timeout: 180000 });

    return {
      count: dataToInsert.length,
      warehouseCounts: Object.fromEntries(
        ACTIVE_WAREHOUSES.map((warehouse) => [warehouse.id, dataToInsert.filter((item) => item.warehouseId === warehouse.id).length])
      ),
    };
  }

  async getInventoryLevels() {
    await this.ensureConfigLoaded();
    this.lastSyncStats = null;
    let items = [];
    let source = 'NONE';
    let warehouseApiMessage = '';
    const loginConfigured = this.isLoginConfigured();

    if (loginConfigured) {
      try {
        // Also ensure warehouse locations are refreshed
        await this.fetchWarehousesList().catch((e) => console.warn('[Warehouse Service] Location sync warning:', e.message));

        const apiResult = await this.fetchFromWarehouseApi({ maxPages: 100, limit: 500 });
        if (apiResult?.complete) {
          items = apiResult.items || [];
          source = 'WAREHOUSE_API';
          const persisted = await this.persistItems(items);
          this.lastSyncStats = { ...(apiResult.syncStats || {}), ...persisted };
        } else {
          warehouseApiMessage = 'Endpoint inventori PDC Gudang tidak mengembalikan data stok produk.';
        }
      } catch (err) {
        items = [];
        source = 'NONE';
        this.lastSyncStats = null;
        const status = err.response?.status;
        const code = err.code;
        const stage = err.warehouseStage === 'LOGIN' ? 'login' : 'inventory';
        console.warn('[Warehouse Service] Authenticated Warehouse API unavailable.', { status, code, message: err.message });
        warehouseApiMessage = code === 'WAREHOUSE_LOGIN_HTML_RESPONSE'
          ? 'URL login mengembalikan HTML bukan token API.'
          : code === 'WAREHOUSE_TOKEN_MISSING'
            ? 'Login gudang tidak mengembalikan token akses.'
          : status
            ? `Permintaan gudang (${stage}) menghasilkan status HTTP ${status}.`
            : `Endpoint gudang (${stage}) tidak dapat dihubungi: ${err.message}`;
      }
    } else if (this.loginUrl || this.inventoryUrl || this.username || this.password) {
      warehouseApiMessage = 'Konfigurasi login gudang belum lengkap. Atur URL login, username, dan password di menu Pengaturan.';
    }

    const totalValuation = items.reduce((acc, item) => acc + (Number(item.priceMin || 0) * Number(item.totalStock || 0)), 0);

    return {
      status: loginConfigured ? (source === 'WAREHOUSE_API' ? 'ONLINE' : 'UNAVAILABLE') : 'DISCONNECTED',
      dataSource: source,
      warehouseLocation: source === 'WAREHOUSE_API' ? (this.teamName ? `PDC Gudang (${this.teamName})` : 'PDC Gudang API') : 'Belum Terhubung',
      totalSkus: items.length,
      totalPhysicalUnits: items.reduce((acc, item) => acc + (item.totalStock || 0), 0),
      totalAvailableUnits: items.reduce((acc, item) => acc + (item.availableStock || 0), 0),
      totalValuation,
      items,
      syncStats: this.lastSyncStats || null,
      team: this.teamName ? { id: this.teamId, name: this.teamName } : null,
      message: warehouseApiMessage || (items.length ? null : 'Belum ada data inventori dari PDC Gudang. Pastikan konfigurasi terhubung.'),
    };
  }

  async getProductDetail(sku, { warehouseId = null, variantId = null } = {}) {
    if (!sku) throw new Error('SKU produk wajib diisi.');

    const hasWarehouseRequest = warehouseId !== null && warehouseId !== undefined && String(warehouseId) !== '';
    const requestedWarehouseId = isActiveWarehouseId(warehouseId) ? Number(warehouseId) : null;
    const warehouseWhere = hasWarehouseRequest
      ? { warehouseId: requestedWarehouseId || -1 }
      : { warehouseId: { in: ACTIVE_WAREHOUSE_ID_LIST } };

    // One SKU can have one row per active warehouse. Prefer the requested row,
    // otherwise use the row with the highest current stock as metadata source.
    let item = await prisma.warehouseItem.findFirst({
      where: { sku, ...warehouseWhere },
      orderBy: [{ totalStock: 'desc' }, { lastUpdated: 'desc' }],
    });

    if (!item) {
      item = await prisma.warehouseItem.findFirst({
        where: {
          ...warehouseWhere,
          OR: [
            { sku: { contains: sku } },
            { refId: { contains: sku } },
            { name: { contains: sku } },
          ],
        },
      });
    }

    const rawIds = item ? { rawProductId: item.rawProductId, rawVariationId: item.rawVariationId } : null;
    const persistedWarehouseRows = await prisma.warehouseItem.findMany({
      where: {
        sku: item?.sku || sku,
        warehouseId: { in: ACTIVE_WAREHOUSE_ID_LIST },
      },
      orderBy: [{ warehouseId: 'asc' }, { lastUpdated: 'desc' }],
    });
    const persistedWarehouseOptions = ACTIVE_WAREHOUSES.map((warehouse) => {
      const row = persistedWarehouseRows.find((candidate) => Number(candidate.warehouseId) === warehouse.id);
      const totalStock = Number(row?.totalStock || 0);
      return {
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        availableStock: Number(row?.availableStock || 0),
        reservedStock: Number(row?.reservedStock || 0),
        totalStock,
        disabled: totalStock <= 0,
      };
    });

    let activeVariantId = variantId || rawIds?.rawVariationId || item?.rawVariationId || null;
    if (!activeVariantId) {
      activeVariantId = await this.discoverVariantIdBySku({ sku, item });
      if (activeVariantId && item) {
        try {
          await prisma.warehouseItem.updateMany({
            where: { sku: item.sku, warehouseId: item.warehouseId },
            data: { rawVariationId: Number(activeVariantId) || null },
          });
        } catch (err) {
          console.warn('[Warehouse Service] Failed to cache discovered variant id:', err.message);
        }
      }
    }
    let warehouseSkuDetail = null;
    let warehouseDetailSource = 'PDC_VARIANT_API';
    if (activeVariantId) {
      try {
        warehouseSkuDetail = await this.fetchVariantSkuDetail({ variantId: activeVariantId, warehouseId });
        if (warehouseSkuDetail && item) {
          item = {
            ...item,
            sku: warehouseSkuDetail.sku || item.sku,
            totalStock: warehouseSkuDetail.totalStock,
            reservedStock: warehouseSkuDetail.reservedStock,
            availableStock: warehouseSkuDetail.availableStock,
            warehouseId: warehouseSkuDetail.warehouseId || item.warehouseId,
            warehouseName: warehouseSkuDetail.warehouseName || item.warehouseName,
            warehouseLocation: warehouseSkuDetail.warehouseLocation || item.warehouseLocation,
          };
        }
      } catch (err) {
        warehouseDetailSource = 'WAREHOUSE_SNAPSHOT_FALLBACK';
        console.warn('[Warehouse Service] Failed to fetch variant SKU detail; using persisted active warehouse rows:', err.message);
      }
    }

    if (!warehouseSkuDetail && persistedWarehouseRows.length) {
      warehouseDetailSource = 'WAREHOUSE_SNAPSHOT_FALLBACK';
      const requestedWarehouse = hasWarehouseRequest && requestedWarehouseId
        ? persistedWarehouseRows.find((row) => Number(row.warehouseId) === requestedWarehouseId)
        : null;
      const fallbackRow = requestedWarehouse || item || persistedWarehouseRows[0];
      warehouseSkuDetail = {
        variantId: Number(activeVariantId) || activeVariantId || fallbackRow?.rawVariationId || null,
        warehouseId: fallbackRow?.warehouseId || null,
        warehouseName: fallbackRow?.warehouseName || null,
        warehouseLocation: fallbackRow?.warehouseLocation || null,
        sku: fallbackRow?.sku || sku,
        availableStock: Number(fallbackRow?.availableStock || 0),
        reservedStock: Number(fallbackRow?.reservedStock || 0),
        totalStock: Number(fallbackRow?.totalStock || 0),
        noWarehouseMatch: Boolean(hasWarehouseRequest && !requestedWarehouse),
        warehouseStockOptions: persistedWarehouseOptions,
        raw: null,
      };
    }

    // Every history lookup below is scoped to these SKUs.
    const historySkus = [...new Set([sku, item?.sku].filter(Boolean))];

    // 2. Fetch Shopee mapping
    let shopeeProduct = null;
    if (item) {
      // refId and name are optional. Skip absent ones rather than substituting '' —
      // a literal empty-string match would pair this item with any Shopee product
      // persisted without a SKU (persistProducts writes `sku: product.sku || ''`).
      const shopeeMatchers = [
        item.sku ? { sku: item.sku } : null,
        item.refId ? { sku: item.refId } : null,
        item.name ? { name: item.name } : null,
      ].filter(Boolean);

      if (shopeeMatchers.length) {
        shopeeProduct = await prisma.shopeeProduct.findFirst({ where: { OR: shopeeMatchers } });
      }
    }

    // 3. Fetch Stock Movement History
    const movements = await prisma.stockMovement.findMany({
      where: { sku: { in: historySkus }, type: 'OUT' },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });

    // 4. Fetch Stock Snapshots (historical trends)
    const snapshots = await prisma.warehouseStockSnapshot.findMany({
      where: { sku: { in: historySkus } },
      orderBy: { date: 'desc' },
      take: 30,
    });

    // 5. Fetch Reconciliation History
    const reconciliations = await prisma.stockReconciliation.findMany({
      where: { sku: { in: historySkus } },
      orderBy: { checkedAt: 'desc' },
      take: 10,
    });

    // 3b. The warehouse itself knows both directions; the local table only ever holds
    // outbound rows. Fail-soft: the detail view must still open when this call cannot.
    const flow = item
      ? await this.fetchVariantStockFlow({
        productId: item.rawProductId,
        variantId: item.rawVariationId,
        sku: item.sku,
      }).catch((err) => ({ source: 'UNAVAILABLE', rows: [], message: err.message }))
      : { source: 'UNAVAILABLE', rows: [], message: null };
    const liveFlow = flow.source === 'WAREHOUSE_API' && flow.rows.length > 0;
    const shownMovements = liveFlow ? flow.rows : movements;

    // Compute stock stats
    const localTotalOut = movements.filter((m) => m.type === 'OUT').reduce((acc, m) => acc + m.quantity, 0);
    const flowTotals = liveFlow ? this.summariseMovements(flow.rows) : null;
    const totalOut = flowTotals ? flowTotals.totalOut : localTotalOut;
    // Without the live flow there is no inbound source at all, so this is unmeasured —
    // null, never 0, which would read as "nothing ever came in".
    const totalIn = flowTotals ? flowTotals.totalIn : null;
    const currentStock = item ? item.availableStock : 0;
    const valuation = item ? (item.priceMin || 0) * (item.totalStock || 0) : 0;

    // An unknown SKU is a 404, not a product whose every field happens to be zero.
    // Returning a synthetic row here made "not found" indistinguishable from
    // "found, but empty".
    if (!item) {
      return {
        found: false,
        sku,
        message: `SKU ${sku} tidak ditemukan pada snapshot gudang.`,
      };
    }

    return {
      found: true,
      product: item,
      shopeeProduct,
      stats: {
        totalIn,
        totalOut,
        currentStock,
        valuation,
        movementCount: shownMovements.length,
      },
      movements: shownMovements,
      movementAvailability: liveFlow
        ? {
          inbound: true,
          outbound: true,
          source: 'PDC_GUDANG',
          // The totals above cover this window only. A variant can hold tens of thousands
          // of rows, so calling them lifetime totals would be a claim we cannot support.
          window: {
            rows: flow.rows.length,
            totalItems: flow.totalItems,
            complete: flow.totalItems <= flow.rows.length,
          },
          message: null,
        }
        : {
          inbound: false,
          outbound: true,
          source: 'LOCAL_SNAPSHOT',
          message: flow.message || 'Riwayat penerimaan stok belum tersedia karena endpoint sumber belum terhubung.',
        },
      snapshots,
      reconciliations,
      warehouseSkuDetail,
      warehouseStockOptions: warehouseSkuDetail?.warehouseStockOptions || persistedWarehouseOptions,
      warehouseDetailSource,
    };
  }

  /**
   * Movement history for one variant, straight from PDC Gudang
   * (warehouse_endpoint.json -> /v1/invertories/stock_flow).
   *
   * Both ids are required: `product_id` on its own makes the endpoint hang past the
   * timeout, while `product_id` + `variant_id` answers immediately.
   *
   * These rows carry the direction our own `StockMovement` table never recorded —
   * `restock` and `return` arrive with a positive count, `order` with a negative one —
   * which is the reason a stock-in figure could previously only ever be zero.
   */
  async fetchVariantStockFlow({ productId, variantId, sku = '', limit = 100, page = 1 } = {}) {
    if (!productId || !variantId) {
      return { source: 'UNAVAILABLE', rows: [], message: 'Varian ini belum memiliki id produk/varian gudang, sehingga riwayat mutasi tidak dapat diambil.' };
    }
    if (!this.isLoginConfigured()) {
      return { source: 'UNAVAILABLE', rows: [], message: 'Koneksi gudang belum dikonfigurasi di Pengaturan.' };
    }

    let origin = 'https://pdcgudang.et.r.appspot.com';
    try {
      origin = new URL(this.inventoryUrl || this.loginUrl || origin).origin;
    } catch {
      // keep the default origin
    }
    // The endpoint pages, and a busy variant can hold tens of thousands of rows, so what
    // comes back is a window over the history — never the whole of it.
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const safePage = Math.max(1, Number(page) || 1);
    const url = `${origin}/v1/invertories/stock_flow?product_id=${encodeURIComponent(productId)}&variant_id=${encodeURIComponent(variantId)}&limit=${safeLimit}&page=${safePage}`;

    try {
      const payload = await this.fetchAuthenticatedData(url);
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const info = payload?.page_info || {};
      const totalItems = Number(info.total_items);
      return {
        source: 'WAREHOUSE_API',
        rows: rows.map((row, index) => this.normalizeStockFlowRow(row, sku, index)),
        page: Number(info.current_page) || safePage,
        limit: safeLimit,
        totalItems: Number.isFinite(totalItems) ? totalItems : rows.length,
        totalPages: Number(info.total_page) || 1,
        message: null,
      };
    } catch (err) {
      const status = err.response?.status;
      return {
        source: 'UNAVAILABLE',
        rows: [],
        message: status === 403 || status === 500
          ? 'Akun gudang ini tidak memiliki izin membaca riwayat mutasi varian.'
          : `Riwayat mutasi gudang tidak dapat diambil${status ? ` (HTTP ${status})` : ''}.`,
      };
    }
  }

  normalizeStockFlowRow(row, sku, index) {
    const count = Number(row?.count) || 0;
    const flowType = String(row?.type || '').toLowerCase();
    const status = String(row?.status || '').toLowerCase();
    const labels = {
      restock: 'Restock masuk',
      return: 'Retur masuk',
      order: 'Pesanan keluar',
      transfer_in: 'Transfer masuk',
      transfer_out: 'Transfer keluar',
    };
    // The sign is not a direction: only `order` arrives negative. A `transfer_out` comes
    // back with a positive count exactly like `transfer_in`, so reading the sign counted
    // outgoing transfers as stock received. Direction comes from the type.
    const DIRECTION = {
      restock: 'IN',
      return: 'IN',
      transfer_in: 'IN',
      order: 'OUT',
      transfer_out: 'OUT',
    };
    const warehouseId = Number(row?.sku_data?.warehouse_id) || null;
    const warehouse = ACTIVE_WAREHOUSES.find((entry) => entry.id === warehouseId);
    return {
      id: `FLOW-${row?.sku_id || sku || 'sku'}-${row?.created || index}-${index}`,
      sku: sku || row?.sku_id || '',
      // An unrecognised type falls back to the sign, and only when the sign is decisive.
      type: DIRECTION[flowType] || (count < 0 ? 'OUT' : count > 0 ? 'IN' : 'UNKNOWN'),
      warehouseId,
      warehouseName: warehouse?.name || (warehouseId ? `Gudang ${warehouseId}` : ''),
      flowType,
      quantity: Math.abs(count),
      status,
      // A cancelled row never moved stock. It stays visible, but totals must skip it.
      counted: status === 'completed',
      reference: row?.receipt || '',
      source: 'PDC_GUDANG',
      note: `${labels[flowType] || flowType || 'Mutasi'}${status && status !== 'completed' ? ` (${status})` : ''}`,
      timestamp: row?.created || null,
      sentAt: row?.send_at || null,
      arrivedAt: row?.arrived || null,
      actor: row?.create_by?.username || row?.create_by?.name || '',
    };
  }

  summariseMovements(rows) {
    const counted = rows.filter((row) => row.counted !== false);
    const sum = (direction) => counted
      .filter((row) => row.type === direction)
      .reduce((total, row) => total + Number(row.quantity || 0), 0);
    return { totalIn: sum('IN'), totalOut: sum('OUT') };
  }

  async getProductStockHistory(sku, { limit = 50, type = null } = {}) {
    const requestedType = type ? type.toUpperCase() : null;
    const item = await prisma.warehouseItem.findFirst({ where: { sku } });
    const flow = await this.fetchVariantStockFlow({
      productId: item?.rawProductId,
      variantId: item?.rawVariationId,
      sku,
      limit,
    });

    if (flow.source === 'WAREHOUSE_API' && flow.rows.length) {
      const rows = requestedType ? flow.rows.filter((row) => row.type === requestedType) : flow.rows;
      const totals = this.summariseMovements(rows);
      return {
        sku,
        totalIn: totals.totalIn,
        totalOut: totals.totalOut,
        count: rows.length,
        movements: rows,
        movementAvailability: {
          inbound: true,
          outbound: true,
          source: 'PDC_GUDANG',
          window: { rows: flow.rows.length, totalItems: flow.totalItems, complete: flow.totalItems <= flow.rows.length },
          message: null,
        },
      };
    }

    // Fallback: the locally recorded movements, which only ever contain outbound rows.
    // totalIn stays null — unmeasured, not zero.
    const movements = requestedType === 'IN' ? [] : await prisma.stockMovement.findMany({
      where: { sku, type: 'OUT' },
      orderBy: { timestamp: 'desc' },
      take: Number(limit) || 50,
    });

    return {
      sku,
      totalIn: null,
      totalOut: movements.reduce((acc, movement) => acc + movement.quantity, 0),
      count: movements.length,
      movements,
      movementAvailability: {
        inbound: false,
        outbound: true,
        source: 'LOCAL_SNAPSHOT',
        message: flow.message || 'Riwayat penerimaan stok belum tersedia karena endpoint sumber belum terhubung.',
      },
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
        price: item.priceMin || shopeeProduct?.price || 0,
        priceMax: item.priceMax || item.priceMin || shopeeProduct?.price || 0,
        size: item.size,
        color: item.color,
        totalStock: item.totalStock,
        reservedStock: item.reservedStock,
        warehouseStock,
        shopeeStock,
        location: item.location,
        warehouseId: item.warehouseId,
        warehouseName: item.warehouseName,
        warehouseLocation: item.warehouseLocation,
        teamName: item.teamName,
        productType: item.productType,
        variance,
        status,
        recommendedAction:
          variance === 0
            ? 'Stok Shopee dan Gudang seimbang.'
            : variance < 0
              ? `Tambah stok Shopee sebanyak ${Math.abs(variance)} unit.`
              : `Kurangi stok Shopee sebanyak ${variance} unit untuk mencegah overselling.`,
      };
    });

    // Persistence is disabled until the SKU mapping table lands.
    //
    // This block appended one row per SKU-warehouse pair on every sync, with no upsert
    // and no retention: 148,533 rows accumulated from 12 runs in four hours, which at
    // the 30-minute cron is roughly 1.25 million rows a day.
    //
    // Re-running it would also be pointless. Shopee SKUs and warehouse SKUs currently
    // share zero values (catalog SKUs fall back to the Shopee item id), so every row it
    // wrote was an artefact of comparing two disjoint sets. The read path still serves
    // the last-written rows, and getWarehouseSnapshot now marks them unreliable.
    //
    // Phase 2 replaces this with an upserted current-state table keyed by the Shopee
    // sellable unit, plus a compact daily snapshot.

    const discrepanciesCount = reconciliationList.filter((row) => row.status !== 'MATCHED').length;

    return {
      totalAudited: reconciliationList.length,
      matchedCount: reconciliationList.length - discrepanciesCount,
      discrepanciesCount,
      reconciliationList,
      syncStats: inventory.syncStats,
      dataSource: inventory.dataSource,
      message: inventory.message,
    };
  }
}

module.exports = new WarehouseService();
