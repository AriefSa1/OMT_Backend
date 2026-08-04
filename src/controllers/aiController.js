const aiService = require('../services/aiService');

async function generateTitle(req, res) {
  const { productName, category, geminiApiKey } = req.body;
  if (geminiApiKey) aiService.setApiKey(geminiApiKey);

  const result = await aiService.generateProductSEO(productName || 'Aesthetic Silk Blouse', category);
  return res.json(result);
}

async function generateStoreCopy(req, res) {
  const { storeName, geminiApiKey } = req.body;
  if (geminiApiKey) aiService.setApiKey(geminiApiKey);

  const result = await aiService.generateStoreCopywriting(storeName);
  return res.json(result);
}

async function generateAds(req, res) {
  const { campaignName, geminiApiKey } = req.body;
  if (geminiApiKey) aiService.setApiKey(geminiApiKey);

  const result = await aiService.generateAdsKeywords(campaignName);
  return res.json(result);
}

module.exports = {
  generateTitle,
  generateStoreCopy,
  generateAds
};
