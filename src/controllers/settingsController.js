const configService = require('../services/configService');
const aiService = require('../services/aiService');
const shopeeService = require('../services/shopeeService');
const warehouseService = require('../services/warehouseService');
const { initCronJobs } = require('../cron/syncCron');
const { wrapHandlers } = require('../utils/asyncHandler');

async function getSettings(req, res) {
  try {
    const config = await configService.getAll();

    const settingsObj = {
      storeName: config.storeName,
      cronInterval: config.cronInterval,
      warehouseLoginUrl: config.warehouseLoginUrl,
      warehouseInventoryUrl: config.warehouseInventoryUrl,
      warehouseUsername: config.warehouseUsername,
      warehouseLoginFrom: config.warehouseLoginFrom,
      warehouseLoginConfigured: Boolean(config.warehouseLoginUrl && config.warehouseInventoryUrl),
      warehouseCredentialsConfigured: Boolean(config.warehouseUsername && config.warehousePassword),
      shopeeAdsUrl: config.shopeeAdsUrl,
      shopeeOrderSummaryUrl: config.shopeeOrderSummaryUrl,
      cookieConfigured: Boolean(config.cookieString),
      geminiApiKeyConfigured: Boolean(config.geminiApiKey),
      openRouterApiKeyConfigured: Boolean(config.openrouterApiKey || config.openRouterApiKey),
    };

    return res.json({
      success: true,
      settings: settingsObj,
      config: settingsObj
    });
  } catch (err) {
    console.error('[settingsController] Error fetching settings:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function updateSettings(req, res) {
  try {
    const { 
      storeName, 
      cookieString, 
      rawCookie, 
      geminiApiKey, 
      geminiKey,
      openrouterApiKey,
      cronInterval, 
      warehouseUrl,
      warehouseLoginUrl,
      warehouseInventoryUrl,
      warehouseUsername,
      warehousePassword,
      warehouseLoginFrom,
      shopeeAdsUrl,
      shopeeOrderSummaryUrl,
    } = req.body;

    const targetCookie = cookieString !== undefined ? cookieString : rawCookie;
    const targetGeminiKey = geminiApiKey !== undefined ? geminiApiKey : geminiKey;

    const targetWarehouseInventoryUrl = warehouseInventoryUrl !== undefined ? warehouseInventoryUrl : warehouseUrl;
    const warehouseSettings = {
      warehouseLoginUrl,
      warehouseInventoryUrl: targetWarehouseInventoryUrl,
      warehouseUsername,
      warehouseLoginFrom,
    };
    if (warehousePassword) warehouseSettings.warehousePassword = warehousePassword;

    const updatedConfig = await configService.setMany({
      storeName,
      cookieString: targetCookie,
      geminiApiKey: targetGeminiKey,
      openrouterApiKey, // <-- NEW: OpenRouter API key for fallback
      cronInterval,
      ...warehouseSettings,
      shopeeAdsUrl,
      shopeeOrderSummaryUrl,
    });

    // Immediate runtime update for active services
    if (targetGeminiKey !== undefined) {
      aiService.setApiKey(targetGeminiKey);
    }
    if (openrouterApiKey !== undefined) {
      aiService.setOpenRouterApiKey(openrouterApiKey);
    }

    if (targetCookie !== undefined) {
      shopeeService.setCookie(targetCookie);
    }

    if (warehouseLoginUrl !== undefined || targetWarehouseInventoryUrl !== undefined || warehouseUsername !== undefined || warehousePassword || warehouseLoginFrom !== undefined) {
      warehouseService.setWarehouseConfig({
        loginUrl: updatedConfig.warehouseLoginUrl,
        inventoryUrl: updatedConfig.warehouseInventoryUrl,
        username: updatedConfig.warehouseUsername,
        password: updatedConfig.warehousePassword,
        loginFrom: updatedConfig.warehouseLoginFrom,
      });
    }

    if (cronInterval !== undefined) {
      initCronJobs(updatedConfig.cronInterval);
    }

    const settingsObj = {
      storeName: updatedConfig.storeName,
      cronInterval: updatedConfig.cronInterval,
      warehouseLoginUrl: updatedConfig.warehouseLoginUrl,
      warehouseInventoryUrl: updatedConfig.warehouseInventoryUrl,
      warehouseUsername: updatedConfig.warehouseUsername,
      warehouseLoginFrom: updatedConfig.warehouseLoginFrom,
      warehouseLoginConfigured: Boolean(updatedConfig.warehouseLoginUrl && updatedConfig.warehouseInventoryUrl),
      warehouseCredentialsConfigured: Boolean(updatedConfig.warehouseUsername && updatedConfig.warehousePassword),
      shopeeAdsUrl: updatedConfig.shopeeAdsUrl,
      shopeeOrderSummaryUrl: updatedConfig.shopeeOrderSummaryUrl,
      cookieConfigured: Boolean(updatedConfig.cookieString),
      geminiApiKeyConfigured: Boolean(updatedConfig.geminiApiKey),
    };

    return res.json({
      success: true,
      message: 'Settings updated successfully',
      settings: settingsObj,
      config: settingsObj
    });
  } catch (err) {
    console.error('[settingsController] Error updating settings:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function testWarehouseConnection(req, res) {
  try {
    const { loginUrl, inventoryUrl, username, password, loginFrom } = req.body || {};
    const result = await warehouseService.testConnection({
      loginUrl,
      inventoryUrl,
      username,
      password,
      loginFrom,
    });
    return res.json(result);
  } catch (err) {
    console.error('[settingsController] Error testing warehouse connection:', err.message);
    return res.status(500).json({ success: false, error: err.message, message: err.message });
  }
}

module.exports = wrapHandlers({
  getSettings,
  updateSettings,
  testWarehouseConnection,
});
