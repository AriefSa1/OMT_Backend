const prisma = require('../utils/prisma');

const DEFAULTS = {
  storeName: process.env.STORE_NAME || '',
  cookieString: '',
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '', // backward-compat alias
  cronInterval: process.env.CRON_INTERVAL || '15m',
  warehouseLoginUrl: process.env.WAREHOUSE_LOGIN_URL || 'https://pdcgudang.et.r.appspot.com/v1/users/login',
  warehouseInventoryUrl: process.env.WAREHOUSE_INVENTORY_URL || 'https://pdcgudang.et.r.appspot.com/v1/products/list',
  warehouseUsername: process.env.WAREHOUSE_USERNAME || '',
  warehousePassword: process.env.WAREHOUSE_PASSWORD || '',
  warehouseLoginFrom: process.env.WAREHOUSE_LOGIN_FROM || 'selling',
  shopeeAdsUrl: process.env.SHOPEE_ADS_ENDPOINT || '',
};

class ConfigService {
  async getAll() {
    const rows = await prisma.systemConfig.findMany();
    const config = { ...DEFAULTS };

    for (const row of rows) {
      config[row.key] = row.value;
    }

    return config;
  }

  async setMany(values) {
    const entries = Object.entries(values).filter(([, value]) => value !== undefined);

    await prisma.$transaction(
      entries.map(([key, value]) =>
        prisma.systemConfig.upsert({
          where: { key },
          update: { value: String(value || '') },
          create: { key, value: String(value || '') },
        })
      )
    );

    return this.getAll();
  }
}

module.exports = new ConfigService();
