const { GoogleGenAI } = require('@google/genai');

/**
 * Sorts a Gemini failure into what the caller can actually do about it.
 *
 * The SDK throws an `ApiError` with a numeric `.status` and a JSON-encoded `.message`.
 * `RATE_LIMITED` (429) is the common case on the free tier and is retryable — Google
 * itself returns a `retryDelay` naming how long to wait, and empirically a retry after
 * that delay often succeeds despite the quota's `PerDay` name. `UNAVAILABLE` (5xx) is a
 * transient outage, also worth one retry. Everything else (bad request, a response that
 * was not the JSON we asked for) is not: retrying would just repeat the same failure.
 */
function classifyGeminiError(err) {
  const status = Number(err?.status);
  let retryDelaySeconds = null;
  try {
    const parsed = JSON.parse(err?.message || '{}');
    const detail = parsed?.error?.details?.find((d) => d['@type']?.includes('RetryInfo'));
    const match = /^(\d+(?:\.\d+)?)s$/.exec(detail?.retryDelay || '');
    if (match) retryDelaySeconds = Number(match[1]);
  } catch {
    // err.message was not the SDK's JSON envelope (e.g. our own JSON.parse of a bad
    // model response) — fall through with no retry delay.
  }

  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      retryable: true,
      retryDelaySeconds: retryDelaySeconds ?? 15,
      message: 'Kuota Gemini API sedang penuh. Sistem mencoba lagi secara otomatis.',
    };
  }
  if (status >= 500 && status < 600) {
    return { code: 'UNAVAILABLE', retryable: true, retryDelaySeconds: retryDelaySeconds ?? 5, message: 'Layanan Gemini sedang tidak stabil. Sistem mencoba lagi secara otomatis.' };
  }
  if (err instanceof SyntaxError) {
    return { code: 'INVALID_RESPONSE', retryable: false, retryDelaySeconds: 0, message: 'Gemini mengembalikan respons yang tidak dapat dibaca.' };
  }
  return { code: status ? `HTTP_${status}` : 'UNKNOWN', retryable: false, retryDelaySeconds: 0, message: 'Permintaan ke Gemini gagal.' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  /**
   * Gemini was configured but the request or its response failed, even after the retries
   * in `generateJson` were exhausted. `errorCode` carries `classifyGeminiError`'s verdict
   * (e.g. `RATE_LIMITED`) so the frontend can show a specific reason instead of a generic
   * "gagal" — the difference between "kuota API habis, sistem sudah mencoba lagi" and an
   * actual defect matters to whoever is looking at the screen.
   */
  aiFailed(payload = {}, message = 'Permintaan ke Gemini gagal.', errorCode = 'UNKNOWN') {
    return {
      ...payload,
      success: false,
      provider: 'ERROR',
      errorCode,
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

  /**
   * One call to Gemini, retried up to `maxRetries` times when `classifyGeminiError` says
   * the failure is transient (429 quota/rate limit, 5xx outage) — waiting the delay
   * Google itself names in the error. A non-retryable failure (bad request, unparsable
   * response) throws immediately on the first attempt; there is nothing a retry would fix.
   *
   * The thrown error always carries `.aiErrorCode`/`.aiErrorMessage` (from the last
   * classification attempted) so every caller can build a specific envelope without
   * re-deriving it.
   */
  async generateJson(prompt, { maxRetries = 2 } = {}) {
    if (!this.ai) return null;

    let lastClassified = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await this.ai.models.generateContent({
          model: this.modelName,
          contents: prompt,
          config: {
            // Meminta JSON lewat kalimat prompt saja tidak cukup — briefing harian pernah
            // gagal dengan JSON terpotong di tengah array. responseMimeType membuat API
            // yang menjamin bentuknya, bukan kepatuhan model terhadap instruksi teks.
            responseMimeType: 'application/json',
            // gemini-2.5-flash mengaktifkan "thinking" secara default dan token berpikir itu
            // dipotong dari anggaran keluaran yang sama. Untuk keluaran terstruktur seperti
            // ini, itu memakan ruang yang seharusnya dipakai jawaban dan membuat respons
            // panjang terpotong. Anggaran dinaikkan sekaligus berpikirnya dimatikan.
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        const text = response.text || '';
        const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
      } catch (err) {
        lastClassified = classifyGeminiError(err);
        const attemptsLeft = attempt < maxRetries;
        if (!lastClassified.retryable || !attemptsLeft) {
          const finalError = new Error(err.message);
          finalError.aiErrorCode = lastClassified.code;
          finalError.aiErrorMessage = lastClassified.message;
          throw finalError;
        }
        console.warn(`[AI Service] ${lastClassified.code}, retrying in ${lastClassified.retryDelaySeconds}s (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(Math.min(lastClassified.retryDelaySeconds, 20) * 1000);
      }
    }
    // Unreachable — the loop always returns or throws — but keeps the function's type honest.
    throw new Error('generateJson exhausted retries without a classified error.');
  }

  /**
   * Shared shape behind every FITUR method below: call Gemini, and on failure build the
   * envelope from what `generateJson` classified rather than a fixed message. Each caller
   * still owns its own input validation and `notConfigured`/`missingInput` guards — those
   * differ per feature — this only removes the identical try/catch/log/envelope tail that
   * used to be copied five times.
   */
  async callGemini({ prompt, trusted = {}, fallbackPayload = {}, failMessage, logLabel }) {
    try {
      const parsed = await this.generateJson(prompt);
      return this.aiResult(parsed, trusted);
    } catch (err) {
      const code = err.aiErrorCode || 'UNKNOWN';
      const message = code === 'RATE_LIMITED' || code === 'UNAVAILABLE' ? err.aiErrorMessage : (failMessage || err.aiErrorMessage);
      console.warn(`[AI Service] ${logLabel || 'Gemini'} error (${code}): ${err.message}`);
      return this.aiFailed({ ...trusted, ...fallbackPayload }, message, code);
    }
  }

  // 3. FITUR 1: AI Automated Copywriter & A/B Testing Variations Generator
  async generateABTestCopy({ name = '', category = '', price = 0, description = '', targetAudience = 'Wanita Muda & Dewasa' }) {
    if (!this.ai) {
      return this.notConfigured({ productName: name, variations: [] });
    }

    return this.callGemini({
      logLabel: 'A/B copy',
      trusted: { productName: name },
      fallbackPayload: { variations: [] },
      failMessage: 'Gagal membuat variasi A/B copy.',
      prompt: `Anda adalah Copywriter E-commerce Senior Shopee Indonesia.
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
}`,
    });
  }

  // 4. FITUR 2: AI Predictive Restock & Deadstock Liquidation Playbook
  async predictRestockAndLiquidation({ name = '', sku = '', stock = 0, salesCount = 0, warehouseStock = null, leadTimeDays = 7, category = '' }) {
    if (warehouseStock === null || warehouseStock === undefined || warehouseStock === '' || !Number.isFinite(Number(warehouseStock))) {
      return this.missingInput(
        { sku, productName: name },
        'Stok gudang belum dapat dipetakan ke SKU produk ini. Prediksi restock belum dapat dihitung.'
      );
    }
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

    return this.callGemini({
      logLabel: 'predictive restock',
      // metrics passed as trusted on both success and failure: model output must never
      // overwrite the arithmetic this service computed itself.
      trusted: { sku, productName: name, metrics },
      fallbackPayload: { liquidationPlaybook: null },
      failMessage: 'Gagal menganalisis prediksi restock.',
      prompt: `Anda adalah pakar Supply Chain & Inventory Analytics E-commerce Shopee.
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
}`,
    });
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

    return this.callGemini({
      logLabel: 'pricing simulator',
      trusted: { productName: name, input, calculations },
      failMessage: 'Gagal mengambil rekomendasi harga dari Gemini. Perhitungan margin tetap ditampilkan.',
      prompt: `Anda adalah Pricing Strategist E-commerce Shopee Indonesia.
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
}`,
    });
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

    return this.callGemini({
      logLabel: 'daily briefing',
      trusted: { date: todayStr },
      // criticalAlerts are derived from real roas/discrepancies above, so they must
      // survive a Gemini failure too — not just the notConfigured path.
      fallbackPayload: { criticalAlerts },
      failMessage: 'Gagal menyusun briefing harian.',
      prompt: `Anda adalah konsultan operasional e-commerce Shopee Indonesia yang dibayar untuk MEMBERI SOLUSI, bukan membacakan angka.

DATA SNAPSHOT TOKO (${todayStr}):
- GMV terakhir: ${orUnknown(gmv, (v) => `Rp ${v.toLocaleString('id-ID')}`)}
- Pesanan: ${orUnknown(orders, (v) => `${v} pesanan`)}
- Biaya iklan: ${orUnknown(adSpend, (v) => `Rp ${v.toLocaleString('id-ID')}`)} | ROAS: ${orUnknown(roas, (v) => `${v.toFixed(2)}x`)}
- Selisih stok multi-gudang: ${orUnknown(discrepancies, (v) => `${v} SKU`)}
- Produk teratas: ${topProducts.slice(0, 5).map((p) => `${p.name} (${p.salesCount} terjual)`).join(' | ') || 'belum tersedia'}

ATURAN KERAS:
1. Nilai "belum tersedia" berarti datanya BELUM TERSINKRON. Jangan mengarang angkanya, dan
   jangan menyimpulkan performa dari data yang tidak ada. Kalau sebuah analisis butuh data
   yang tidak ada, katakan data apa yang perlu disinkronkan lebih dulu.
2. DILARANG hanya mengulang angka di atas. Setiap poin yang Anda tulis harus menjawab
   "jadi apa yang harus dilakukan?" — angka hanya boleh muncul sebagai ALASAN dari sebuah
   tindakan, bukan sebagai isi utama.
3. Setiap rekomendasi harus: spesifik (menyebut produk/kampanye/SKU bila ada), dapat
   dikerjakan hari ini oleh satu orang, dan menyebutkan dampak yang diharapkan.
4. Jangan memberi saran generik seperti "tingkatkan kualitas foto" atau "optimalkan
   listing" tanpa menyebut produk mana dan perubahan konkret apa.

Kembalikan JSON murni (tanpa markdown):
{
  "date": "${todayStr}",
  "headline": "Satu kalimat: hal terpenting yang harus diputuskan pemilik toko hari ini",
  "situation": "2-3 kalimat membaca kondisi toko — hubungkan antar metrik (mis. biaya iklan vs pesanan), bukan mendaftar ulang angkanya",
  "priorityActions": [
    {
      "title": "Judul tindakan singkat dan spesifik",
      "why": "Alasan berbasis data di atas — sebutkan angkanya di sini",
      "how": "Langkah konkret yang dikerjakan hari ini, cukup detail untuk langsung dieksekusi",
      "expectedImpact": "Dampak yang realistis diharapkan, mis. 'menekan biaya iklan sia-sia ~Rp X/hari'",
      "urgency": "TINGGI"
    }
  ],
  "risks": [
    { "risk": "Risiko yang mengintai bila dibiarkan", "mitigation": "Cara mencegahnya" }
  ],
  "dataGaps": ["Data yang perlu disinkronkan agar analisis berikutnya lebih tajam"]
}

priorityActions: 2-4 item, urut dari paling mendesak, urgency salah satu dari TINGGI/SEDANG/RENDAH.
risks: 1-3 item. dataGaps: hanya isi bila memang ada data "belum tersedia" di atas, selain itu [].`,
    });
  }

  // 6b. FITUR 6: AI Scale-Up Strategy per produk
  //
  // Berbeda dari A/B copywriter (yang menulis teks listing), fitur ini menjawab pertanyaan
  // "produk ini sudah jalan — bagaimana menaikkannya?" dengan bahan yang benar-benar
  // dimiliki: peringkat penjualan per varian, metrik funnel, dan stok.
  async suggestScaleUpStrategy({
    name = '', category = '', price = 0, stock = 0, salesCount = 0,
    metric = null, variations = [], variationSummary = null,
  } = {}) {
    if (!this.ai) {
      return this.notConfigured({ productName: name });
    }

    // Varian adalah bahan utama analisis ini. Tanpa data penjualan per varian, model hanya
    // akan mengarang mana yang "terlaris" — jadi ditolak lebih awal, bukan dipaksakan.
    if (!variationSummary?.hasSoldData) {
      return this.missingInput(
        { productName: name },
        variationSummary?.message
          || 'Penjualan per varian belum tersedia untuk produk ini, sehingga strategi scale-up berbasis varian belum dapat disusun.'
      );
    }

    const topVariations = variations.slice(0, 8).map((row, index) => {
      const share = Number.isFinite(Number(row.soldShare)) ? ` — ${Number(row.soldShare).toFixed(1)}% dari penjualan varian` : '';
      return `  ${index + 1}. "${row.name}": ${row.soldCount} terjual${share}, stok ${row.stock}`;
    }).join('\n');
    const deadVariations = variations.filter((row) => Number(row.soldCount) === 0);
    const orUnknown = (value, format) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? 'belum tersedia' : format(Number(value)));

    return this.callGemini({
      logLabel: 'scale-up strategy',
      trusted: { productName: name, variationSummary },
      failMessage: 'Gagal menyusun strategi scale-up.',
      prompt: `Anda konsultan pertumbuhan penjual Shopee Indonesia. Tugas Anda MENAIKKAN penjualan produk yang sudah berjalan — bukan meringkas datanya.

PRODUK: "${name}" (kategori: ${category || 'belum tersedia'})
Harga: Rp ${Number(price).toLocaleString('id-ID')} | Stok katalog: ${Number(stock).toLocaleString('id-ID')} | Total terjual: ${Number(salesCount).toLocaleString('id-ID')}

FUNNEL (snapshot terakhir):
- Impresi: ${orUnknown(metric?.impressions, (v) => v.toLocaleString('id-ID'))}
- CTR: ${orUnknown(metric?.ctr, (v) => `${v.toFixed(2)}%`)}
- Pengunjung: ${orUnknown(metric?.visitors, (v) => v.toLocaleString('id-ID'))}
- Masuk keranjang: ${orUnknown(metric?.addToCartBuyers, (v) => `${v} pembeli`)}
- Pesanan terkonfirmasi: ${orUnknown(metric?.confirmedOrders, (v) => String(v))}
- Rasio konversi: ${orUnknown(metric?.conversionRate, (v) => `${v.toFixed(2)}%`)}
- Bounce rate: ${orUnknown(metric?.bounceRate, (v) => `${v.toFixed(2)}%`)}

PENJUALAN PER VARIAN (${variationSummary.count} varian, total ${variationSummary.soldTotal} terjual):
${topVariations}
${deadVariations.length ? `Varian tanpa penjualan sama sekali: ${deadVariations.length} dari ${variationSummary.count} — contoh: ${deadVariations.slice(0, 5).map((row) => `"${row.name}"`).join(', ')}` : 'Semua varian memiliki penjualan.'}

ATURAN KERAS:
1. Nilai "belum tersedia" berarti belum terukur. Jangan mengarang angkanya.
2. Analisis harus BERTUMPU pada sebaran varian di atas — sebutkan nama varian yang Anda
   maksud. Saran yang tidak menyebut varian atau angka spesifik dianggap gagal.
3. Setiap rekomendasi harus menyatakan tindakan konkret yang bisa dieksekusi minggu ini,
   bukan prinsip umum seperti "tingkatkan kualitas konten".
4. Bedakan masalah funnel: impresi rendah = masalah jangkauan; CTR rendah = masalah
   thumbnail/judul/harga tampil; keranjang tinggi tapi pesanan rendah = masalah checkout
   (ongkir, voucher, harga akhir). Tunjuk yang paling relevan bagi produk ini.

Kembalikan JSON murni:
{
  "verdict": "Satu kalimat: peluang terbesar untuk menaikkan produk ini",
  "variantStrategy": {
    "doubleDown": "Varian yang harus didorong dan alasannya (sebut nama varian + angkanya)",
    "fix": "Varian yang perlu diperbaiki dan apa yang harus diubah",
    "retire": "Varian yang sebaiknya dihentikan/disembunyikan, atau 'tidak ada' bila belum perlu"
  },
  "funnelDiagnosis": {
    "bottleneck": "Tahap funnel yang paling menghambat: JANGKAUAN | KLIK | KERANJANG | CHECKOUT",
    "evidence": "Angka yang mendasari kesimpulan itu",
    "fix": "Perbaikan konkret untuk tahap tersebut"
  },
  "scaleUpActions": [
    { "action": "Tindakan spesifik", "how": "Langkah konkret", "expectedImpact": "Dampak realistis yang diharapkan", "effort": "RENDAH" }
  ],
  "stockRisk": "Risiko stok bila penjualan naik sesuai rencana, berdasarkan stok varian di atas",
  "dataGaps": ["Data yang perlu disinkronkan agar analisis lebih tajam"]
}

scaleUpActions: 3-5 item, effort salah satu dari RENDAH/SEDANG/TINGGI. dataGaps: [] bila tidak ada.`,
    });
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

    return this.callGemini({
      logLabel: 'ads optimization',
      trusted: { campaignName, summary },
      fallbackPayload: { negativeKeywordsToExclude: [], bidAdjustments: [], scaleKeywordsRecommended: [] },
      failMessage: 'Gagal menganalisis kampanye iklan.',
      prompt: `Anda adalah AI Performance Marketing Shopee Ads Bidding Expert.
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
}`,
    });
  }
}

module.exports = new AIService();
