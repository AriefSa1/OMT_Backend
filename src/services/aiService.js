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

  isConfigured() {
    return Boolean(this.ai);
  }

  /**
   * No Gemini key configured. Returns deterministic values the caller computed itself
   * (metrics, calculations) but NEVER invented advice, scores or recommendations —
   * those would be indistinguishable from real model output on screen.
   *
   * Payload is spread FIRST so it can never overwrite the envelope keys.
   */
  notConfigured(payload = {}) {
    return {
      ...payload,
      success: false,
      provider: 'NOT_CONFIGURED',
      model: this.modelName,
      message: 'Kunci API Gemini belum dikonfigurasi. Buka Pengaturan untuk mengaktifkan fitur AI.',
    };
  }

  /** A required input was not supplied, so nothing was computed. */
  missingInput(payload = {}, message = 'Data masukan belum lengkap.') {
    return {
      ...payload,
      success: false,
      provider: 'MISSING_INPUT',
      model: this.modelName,
      message,
    };
  }

  /** Gemini was configured but the request or its response failed. */
  aiFailed(payload = {}, message = 'Permintaan ke Gemini gagal.') {
    return {
      ...payload,
      success: false,
      provider: 'ERROR',
      model: this.modelName,
      message,
    };
  }

  /**
   * Live model result. `parsed` is spread FIRST so model output cannot overwrite the
   * envelope, nor the deterministic blocks the caller passes in `trusted`.
   */
  aiResult(parsed, trusted = {}) {
    return {
      ...parsed,
      ...trusted,
      success: true,
      provider: 'REAL_GEMINI_API',
      model: this.modelName,
    };
  }

  async generateJson(prompt) {
    if (!this.ai) return null;

    const response = await this.ai.models.generateContent({
      model: this.modelName,
      contents: prompt,
    });

    const text = response.text || '';
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  }

  // 3. FITUR 1: AI Automated Copywriter & A/B Testing Variations Generator
  async generateABTestCopy({ name = '', category = '', price = 0, description = '', targetAudience = 'Wanita Muda & Dewasa' }) {
    if (!this.ai) {
      return this.notConfigured({ productName: name, variations: [] });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah Copywriter E-commerce Senior Shopee Indonesia.
Buat 3 variasi copywriting A/B Testing lengkap untuk produk berikut:
Nama: "${name}"
Kategori: "${category}"
Harga: Rp ${price}
Deskripsi Singkat: "${description}"
Target Audience: "${targetAudience}"

Kembalikan JSON murni dengan 3 variasi (SEO_OPTIMIZED, PROMO_DRIVEN, EMOTIONAL_BENEFIT):
{
  "productName": "${name}",
  "variations": [
    {
      "variantType": "SEO_OPTIMIZED",
      "variantLabel": "Varian A: Fokus Algoritma SEO Shopee",
      "title": "Judul SEO 80-100 karakter kaya kata kunci",
      "tagline": "Alasan pendekatan ini",
      "bullets": ["Poin keunggulan 1", "Poin keunggulan 2", "Poin keunggulan 3"],
      "shortCopy": "Deskripsi copy 2-3 kalimat menarik",
      "recommendedTags": ["#tag1", "#tag2", "#tag3", "#tag4"]
    },
    {
      "variantType": "PROMO_DRIVEN",
      "variantLabel": "Varian B: Fokus Promo & Urgensi Diskon",
      "title": "Judul promo dengan trigger urgensi & diskon",
      "tagline": "Alasan pendekatan ini",
      "bullets": ["Poin promo 1", "Poin promo 2", "Poin promo 3"],
      "shortCopy": "Deskripsi copy promo mendesak",
      "recommendedTags": ["#tag1", "#tag2", "#tag3", "#tag4"]
    },
    {
      "variantType": "EMOTIONAL_BENEFIT",
      "variantLabel": "Varian C: Fokus Estetika & Kepercayaan Diri",
      "title": "Judul emosional yang menyentuh lifestyle & estetika",
      "tagline": "Alasan pendekatan ini",
      "bullets": ["Poin manfaat emosional 1", "Poin manfaat emosional 2", "Poin manfaat emosional 3"],
      "shortCopy": "Deskripsi copy storytelling estetis",
      "recommendedTags": ["#tag1", "#tag2", "#tag3", "#tag4"]
    }
  ],
  "confidenceScore": 96
}`);

      return this.aiResult(parsed, { productName: name });
    } catch (err) {
      console.warn(`[AI Service] Gemini A/B copy error: ${err.message}`);
      return this.aiFailed(
        { productName: name, variations: [] },
        'Gagal membuat variasi A/B copy.'
      );
    }
  }

  // 4. FITUR 2: AI Predictive Restock & Deadstock Liquidation Playbook
  async predictRestockAndLiquidation({ name = '', sku = '', stock = 0, salesCount = 0, warehouseStock = 0, leadTimeDays = 7, category = '' }) {
    const totalPhysicalStock = Number(stock || 0) + Number(warehouseStock || 0);
    const measuredDays = 30;
    const dailyVelocity = Math.max(0.01, Number(salesCount || 0) / measuredDays);
    const daysOfInventory = totalPhysicalStock > 0 ? Math.round(totalPhysicalStock / dailyVelocity) : 0;
    
    let urgency = 'HEALTHY';
    if (totalPhysicalStock === 0) urgency = 'OUT_OF_STOCK';
    else if (daysOfInventory <= leadTimeDays) urgency = 'CRITICAL';
    else if (daysOfInventory <= leadTimeDays * 2) urgency = 'WARNING';
    else if (daysOfInventory > 90 || (salesCount === 0 && totalPhysicalStock > 20)) urgency = 'DEADSTOCK';

    const predictedRunoutDate = new Date(Date.now() + (daysOfInventory * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];
    const suggestedBatchReorder = Math.max(20, Math.ceil(dailyVelocity * 30 * 1.2));

    const metrics = {
      currentStock: totalPhysicalStock,
      dailyVelocity: Number(dailyVelocity.toFixed(2)),
      daysOfInventory,
      leadTimeDays,
      predictedRunoutDate,
      urgency,
      suggestedBatchReorder,
    };

    if (!this.ai) {
      // metrics is arithmetic this service computed itself, so it is safe to return.
      // restockRecommendation and liquidationPlaybook were invented prose and are gone.
      return this.notConfigured({ sku, productName: name, metrics });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah pakar Supply Chain & Inventory Analytics E-commerce Shopee.
Analisis data persediaan berikut:
Produk: "${name}" (SKU: ${sku}, Kategori: ${category})
Total Stok Tersedia: ${totalPhysicalStock} unit
Penjualan 30 Hari: ${salesCount} unit (Laju: ${dailyVelocity.toFixed(2)} unit/hari)
Estimasi Sisa Hari Stok (DOIR): ${daysOfInventory} hari
Lead Time Pengadaan: ${leadTimeDays} hari
Status Urgensi: ${urgency}

Kembalikan JSON murni:
{
  "restockRecommendation": "Saran restock yang spesifik dan taktis",
  "liquidationPlaybook": {
    "isDeadstock": ${urgency === 'DEADSTOCK'},
    "clearanceDiscountSuggested": "Persentase diskon yang disarankan misal 20-30%",
    "bundlingIdea": "Ide paket bundling kombo hemat yang menarik",
    "flashSaleStrategy": "Taktik flash sale dan penempatan waktu di Shopee",
    "actionSteps": ["Langkah 1", "Langkah 2", "Langkah 3"]
  },
  "marketDemandForecast": "Proyeksi tren permintaan 30 hari ke depan"
}`);

      // metrics passed as trusted: model output must not overwrite our arithmetic.
      return this.aiResult(parsed, { sku, productName: name, metrics });
    } catch (err) {
      console.warn(`[AI Service] Gemini predictive restock error: ${err.message}`);
      return this.aiFailed(
        { sku, productName: name, metrics, liquidationPlaybook: null },
        'Gagal menganalisis prediksi restock.'
      );
    }
  }

  // 5. FITUR 3: AI Dynamic Pricing & Profit-Margin Simulator
  async simulateDynamicPricing({ name = '', currentPrice = 0, targetPrice = 0, unitCost = 0, unitAdCost = 0, shippingCost = 0, platformFeePercent = null, competitorPrice = 0 }) {
    // The platform fee drives every figure below. Assuming a value (it used to default to
    // 6.5%) produced a margin, breakeven and safety floor that looked measured but were
    // built on a guess. Refuse to compute instead.
    if (platformFeePercent === null || platformFeePercent === undefined || platformFeePercent === '' || !Number.isFinite(Number(platformFeePercent))) {
      return this.missingInput(
        { productName: name },
        'Persentase biaya platform wajib diisi sebelum simulasi dapat dihitung.'
      );
    }

    const price = Number(targetPrice || currentPrice || 0);
    const cogs = Number(unitCost || 0);
    const adCost = Number(unitAdCost || 0);
    const shipping = Number(shippingCost || 0);
    const feePct = Number(platformFeePercent);

    const platformFeeAmount = price * (feePct / 100);
    const totalCost = cogs + adCost + shipping + platformFeeAmount;
    const grossMarginAmount = price - totalCost;
    const grossMarginPercent = price > 0 ? (grossMarginAmount / price) * 100 : 0;

    // Breakeven price: P = (COGS + Ad + Ship) / (1 - feePct / 100)
    const fixedCosts = cogs + adCost + shipping;
    const feeFactor = Math.max(0.01, 1 - (feePct / 100));
    const breakevenPrice = Math.round(fixedCosts / feeFactor);
    const safetyFloorPrice = Math.round(breakevenPrice * 1.15); // 15% safety buffer

    let riskLevel = 'HEALTHY';
    if (grossMarginAmount < 0) riskLevel = 'NEGATIVE_PROFIT';
    else if (grossMarginPercent < 15) riskLevel = 'LOW_MARGIN';
    else if (competitorPrice && price > competitorPrice * 1.35) riskLevel = 'OVERPRICED';

    const input = { currentPrice, targetPrice: price, unitCost: cogs, unitAdCost: adCost, shippingCost: shipping, platformFeePercent: feePct, competitorPrice };
    const calculations = {
      platformFeeAmount: Math.round(platformFeeAmount),
      totalCost: Math.round(totalCost),
      grossMarginAmount: Math.round(grossMarginAmount),
      grossMarginPercent: Number(grossMarginPercent.toFixed(1)),
      breakevenPrice,
      safetyFloorPrice,
      riskLevel,
    };

    if (!this.ai) {
      // calculations is real arithmetic and is returned. aiAdvice is not: optimalPrice
      // used an invented 0.98 undercut and promotionalDiscountBudget an invented 0.4
      // payout, both rendered under an "AI Pricing Strategist" heading.
      return this.notConfigured({ productName: name, input, calculations });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah Pricing Strategist E-commerce Shopee Indonesia.
Analisis simulasi penetapan harga produk berikut:
Produk: "${name}"
Harga Uji Coba: Rp ${price.toLocaleString('id-ID')} (Harga Asli: Rp ${Number(currentPrice).toLocaleString('id-ID')})
COGS: Rp ${cogs.toLocaleString('id-ID')} | Biaya Iklan: Rp ${adCost.toLocaleString('id-ID')} | Biaya Kirim: Rp ${shipping.toLocaleString('id-ID')}
Fee Layanan Shopee: ${feePct}% (Rp ${Math.round(platformFeeAmount).toLocaleString('id-ID')})
Total Biaya per Unit: Rp ${Math.round(totalCost).toLocaleString('id-ID')}
Margin Bersih: Rp ${Math.round(grossMarginAmount).toLocaleString('id-ID')} (${grossMarginPercent.toFixed(1)}%)
Harga Breakeven: Rp ${breakevenPrice.toLocaleString('id-ID')}
Harga Pembanding Kompetitor: ${competitorPrice ? `Rp ${Number(competitorPrice).toLocaleString('id-ID')}` : 'Tidak tersedia'}

Kembalikan JSON murni:
{
  "aiAdvice": {
    "optimalPrice": 125000,
    "elasticityAnalysis": "Penjelasan mendalam mengenai elastisitas harga dan daya saing",
    "competitorBenchmarking": "Evaluasi perbandingan terhadap kompetitor",
    "promotionalDiscountBudget": 15000,
    "actionStrategy": "Rekomendasi taktis untuk menaikkan volume penjualan tanpa mengorbankan margin"
  }
}`);

      return this.aiResult(parsed, { productName: name, input, calculations });
    } catch (err) {
      console.warn(`[AI Service] Gemini pricing simulator error: ${err.message}`);
      return this.aiFailed(
        { productName: name, input, calculations },
        'Gagal mengambil rekomendasi harga dari Gemini. Perhitungan margin tetap ditampilkan.'
      );
    }
  }

  // 6. FITUR 4: AI Automated Daily Store Briefing (Executive Digest)
  async generateDailyBriefing({ storeOverview = {}, adsMetrics = {}, warehouseTotals = {}, topProducts = [] } = {}) {
    const todayStr = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // These KPIs are null when the underlying source has not synced. Coercing them to 0
    // made the briefing state "GMV tercatat Rp 0" as though it had been measured.
    const num = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
    const gmv = num(storeOverview?.kpis?.totalGmv);
    const orders = num(storeOverview?.kpis?.totalOrders);
    const adSpend = num(adsMetrics?.totalSpend);
    const roas = num(adsMetrics?.roas);
    const discrepancies = num(warehouseTotals?.discrepanciesCount);
    const orUnknown = (value, format) => (value === null ? 'belum tersedia' : format(value));

    const criticalAlerts = [
      ...(roas !== null && roas > 0 && roas < 2 ? [`ROAS iklan ${roas.toFixed(2)}x.`] : []),
      ...(discrepancies !== null && discrepancies > 0 ? [`${discrepancies} SKU dengan selisih stok antara Shopee dan Gudang.`] : []),
    ];

    if (!this.ai) {
      // criticalAlerts are derived from real roas/discrepancies, so they survive.
      // healthScore (an if-else ladder), marketOutlook (invented peak hours),
      // priorityActionsToday (a fixed list) and the "Performa toko berjalan stabil"
      // assertion were all invented and are gone.
      return this.notConfigured({ date: todayStr, criticalAlerts });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah AI Chief Operating Officer (COO) untuk Seller Shopee Indonesia.
Analisis snapshot toko hari ini (${todayStr}).
Nilai bertanda "belum tersedia" berarti sumber datanya belum tersinkron — JANGAN mengarang angka untuk itu, dan jangan menyimpulkan performa dari data yang tidak ada.
- Total GMV Terakhir: ${orUnknown(gmv, (v) => `Rp ${v.toLocaleString('id-ID')}`)}
- Total Pesanan: ${orUnknown(orders, (v) => `${v} pesanan`)}
- Pengeluaran Iklan: ${orUnknown(adSpend, (v) => `Rp ${v.toLocaleString('id-ID')}`)} (ROAS: ${orUnknown(roas, (v) => `${v.toFixed(2)}x`)})
- Selisih Stok Multi-Gudang: ${orUnknown(discrepancies, (v) => `${v} SKU bermasalah`)}
- Top Produk: ${topProducts.slice(0, 3).map((p) => `${p.name} (${p.salesCount} terjual)`).join(', ') || 'Katalog terhubung'}

Kembalikan JSON murni:
{
  "date": "${todayStr}",
  "healthScore": 85,
  "executiveSummary": "Ringkasan eksekutif 2-3 kalimat padat mengenai kesehatan toko hari ini",
  "topWinner": "Nama produk dan sorotan performa terbaik",
  "criticalAlerts": [
    "Alert 1 (misal anomali iklan atau stok)",
    "Alert 2"
  ],
  "priorityActionsToday": [
    "Aksi Prioritas 1 yang harus dikerjakan tim hari ini",
    "Aksi Prioritas 2",
    "Aksi Prioritas 3"
  ],
  "marketOutlook": "Proyeksi perilaku pembeli dan jam ramai hari ini"
}`);

      return this.aiResult(parsed, { date: todayStr });
    } catch (err) {
      console.warn(`[AI Service] Gemini daily briefing error: ${err.message}`);
      return this.aiFailed(
        { date: todayStr, criticalAlerts },
        'Gagal menyusun briefing harian.'
      );
    }
  }

  // 7. FITUR 5: AI Ads Negative Keyword & Bid Optimization
  async optimizeAdsKeywordsAndBids({ campaignName = 'Shopee Ads', spend = 0, sales = 0, roas = 0, ctr = 0, category = '' }) {
    const isUnderperforming = roas > 0 && roas < 2.5;
    // Restates the caller's own metrics; adds no claim of its own.
    const summary = `Pengeluaran Rp ${Number(spend).toLocaleString('id-ID')}, ROAS ${Number(roas).toFixed(2)}x, CTR ${Number(ctr).toFixed(2)}%.`;

    if (!this.ai) {
      // This service holds no keyword or search-volume data of any kind. The bids
      // (850/1200/700), search volumes, negative keywords and wastedSpendEstimate
      // (spend * 0.35) were invented, and the UI told users to paste them straight
      // into a live Shopee ad account.
      return this.notConfigured({ campaignName, summary, isUnderperforming });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah AI Performance Marketing Shopee Ads Bidding Expert.
Analisis metrik kampanye iklan berikut:
Kampanye: "${campaignName}" (Kategori: ${category})
Biaya: Rp ${Number(spend).toLocaleString('id-ID')}
Penjualan Iklan: Rp ${Number(sales).toLocaleString('id-ID')}
ROAS: ${Number(roas).toFixed(2)}x
CTR: ${Number(ctr).toFixed(2)}%

Kembalikan JSON murni:
{
  "campaignName": "${campaignName}",
  "summary": "Ringkasan evaluasi performa iklan dan efisiensi biaya",
  "wastedSpendEstimate": 50000,
  "negativeKeywordsToExclude": ["kata kunci negatif 1", "kata kunci 2", "kata kunci 3", "kata kunci 4", "kata kunci 5"],
  "bidAdjustments": [
    { "keywordType": "Kategori Kata Kunci 1", "action": "NAIKKAN_BID", "recommendedAdjustment": "+15%", "reason": "Alasan penyesuaian" },
    { "keywordType": "Kategori Kata Kunci 2", "action": "TURUNKAN_BID", "recommendedAdjustment": "-25%", "reason": "Alasan penyesuaian" }
  ],
  "scaleKeywordsRecommended": [
    { "keyword": "kata kunci target 1", "matchType": "Pencocokan Luas / Spesifik", "suggestedBid": 950, "estimatedSearchVolume": "Tinggi" },
    { "keyword": "kata kunci target 2", "matchType": "Pencocokan Spesifik", "suggestedBid": 1300, "estimatedSearchVolume": "Sedang" }
  ],
  "dailyBudgetStrategy": "Rekomendasi taktis anggaran harian"
}`);

      return this.aiResult(parsed, { campaignName, summary });
    } catch (err) {
      console.warn(`[AI Service] Gemini ads optimization error: ${err.message}`);
      return this.aiFailed(
        { campaignName, summary, negativeKeywordsToExclude: [], bidAdjustments: [], scaleKeywordsRecommended: [] },
        'Gagal menganalisis kampanye iklan.'
      );
    }
  }

}

module.exports = new AIService();
