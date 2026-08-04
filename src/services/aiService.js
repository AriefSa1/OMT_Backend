const { GoogleGenAI } = require('@google/genai');

class AIService {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    this.modelName = 'gemini-2.5-flash';
    this.ai = this.apiKey ? new GoogleGenAI({ apiKey: this.apiKey }) : null;
  }

  setApiKey(key) {
    this.apiKey = key || '';
    this.ai = this.apiKey ? new GoogleGenAI({ apiKey: this.apiKey }) : null;
    console.log(`[AI Service] Gemini API key ${this.ai ? 'configured' : 'cleared'}.`);
  }

  notConfigured(payload) {
    return {
      success: false,
      provider: 'NOT_CONFIGURED',
      model: this.modelName,
      ...payload,
    };
  }

  async generateJson(prompt) {
    if (!this.ai) return null;

    const response = await this.ai.models.generateContent({
      model: this.modelName,
      contents: prompt,
    });

    const cleaned = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  }

  async generateProductSEO(productName, category = 'Women Fashion') {
    if (!this.ai) {
      return this.notConfigured({
        originalTitle: productName,
        aiGeneratedTitle: '',
        seoScore: 0,
        suggestedKeywords: [],
        pricingAnalysis: null,
        message: 'Configure a Gemini API key in Settings to generate product SEO recommendations.',
      });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah pakar e-commerce Shopee Indonesia.
Optimasi produk berikut untuk listing Shopee:
Nama Produk Asli: "${productName}"
Kategori: "${category}"

Kembalikan JSON murni:
{
  "aiGeneratedTitle": "Judul baru maksimal 100 karakter",
  "seoScore": 98,
  "suggestedKeywords": ["keyword 1", "keyword 2", "keyword 3"],
  "pricingAnalysis": {
    "suggestedDiscountPercent": "15%",
    "estimatedConversionBoost": "+28%"
  }
}`);

      return {
        success: true,
        provider: 'REAL_GEMINI_API',
        model: this.modelName,
        originalTitle: productName,
        ...parsed,
      };
    } catch (err) {
      console.warn(`[AI Service] Gemini product SEO error: ${err.message}`);
      return this.notConfigured({
        originalTitle: productName,
        aiGeneratedTitle: '',
        seoScore: 0,
        suggestedKeywords: [],
        pricingAnalysis: null,
        message: 'Gemini request failed. Check the API key in Settings.',
      });
    }
  }

  async generateStoreCopywriting(storeName = 'Shopee Store') {
    if (!this.ai) {
      return this.notConfigured({
        storeBio: '',
        autoReplies: [],
        bannerSlogans: [],
        message: 'Configure a Gemini API key in Settings to generate store copy.',
      });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah pakar Customer Experience Shopee Indonesia.
Buatkan deskripsi toko dan 3 template balasan chat CS otomatis untuk toko: "${storeName}".

Kembalikan JSON murni:
{
  "storeBio": "Deskripsi toko",
  "autoReplies": [
    { "trigger": "Salam", "response": "Balasan" }
  ],
  "bannerSlogans": ["Slogan 1", "Slogan 2"]
}`);

      return {
        success: true,
        provider: 'REAL_GEMINI_API',
        model: this.modelName,
        ...parsed,
      };
    } catch (err) {
      console.warn(`[AI Service] Gemini store copy error: ${err.message}`);
      return this.notConfigured({
        storeBio: '',
        autoReplies: [],
        bannerSlogans: [],
        message: 'Gemini request failed. Check the API key in Settings.',
      });
    }
  }

  async generateAdsKeywords(campaignName = 'Shopee Ads Campaign') {
    if (!this.ai) {
      return this.notConfigured({
        campaignName,
        targetROAS: 0,
        recommendedKeywords: [],
        negativeKeywordsToExclude: [],
        message: 'Configure a Gemini API key in Settings to generate ads keyword recommendations.',
      });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah pakar Shopee Ads Bidding Indonesia.
Analisis kampanye: "${campaignName}".

Kembalikan JSON murni:
{
  "campaignName": "${campaignName}",
  "targetROAS": 7.1,
  "recommendedKeywords": [
    { "keyword": "keyword", "searchVolume": "120000/bulan", "recommendedBid": 1100, "roasPotential": "7.5x" }
  ],
  "negativeKeywordsToExclude": ["keyword negatif"]
}`);

      return {
        success: true,
        provider: 'REAL_GEMINI_API',
        model: this.modelName,
        ...parsed,
      };
    } catch (err) {
      console.warn(`[AI Service] Gemini ads keyword error: ${err.message}`);
      return this.notConfigured({
        campaignName,
        targetROAS: 0,
        recommendedKeywords: [],
        negativeKeywordsToExclude: [],
        message: 'Gemini request failed. Check the API key in Settings.',
      });
    }
  }
}

module.exports = new AIService();
