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

    const text = response.text || '';
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  }

  // 1. Product SEO & Title Generator
  async generateProductSEO(productName, category = 'Women Fashion') {
    if (!this.ai) {
      return this.notConfigured({
        originalTitle: productName,
        aiGeneratedTitle: `[BEST SELLER] ${productName} - Premium Quality`,
        seoScore: 85,
        suggestedKeywords: [productName, category, 'kualitas premium', 'terbaru 2026', 'promo shopee'],
        pricingAnalysis: {
          suggestedDiscountPercent: '10%',
          estimatedConversionBoost: '+20%',
        },
        message: 'Configure a Gemini API key in Settings to generate live product SEO recommendations.',
      });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah pakar e-commerce Shopee Indonesia.
Optimasi produk berikut untuk listing Shopee:
Nama Produk Asli: "${productName}"
Kategori: "${category}"

Kembalikan JSON murni:
{
  "aiGeneratedTitle": "Judul baru maksimal 100 karakter yang SEO-friendly",
  "seoScore": 95,
  "suggestedKeywords": ["keyword 1", "keyword 2", "keyword 3", "keyword 4"],
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
        aiGeneratedTitle: `[PREMIUM] ${productName} - Pilihan Terbaik`,
        seoScore: 80,
        suggestedKeywords: [productName, category, 'promo'],
        pricingAnalysis: null,
        message: 'Gemini request encountered an issue. Fallback data shown.',
      });
    }
  }

  // 2. Store Copywriting
  async generateStoreCopywriting(storeName = 'Shopee Store') {
    if (!this.ai) {
      return this.notConfigured({
        storeBio: `Selamat datang di toko resmi ${storeName}! Kami menghadirkan produk fashion & apparel wanita berkualitas dengan harga terjangkau. Pengiriman cepat & amanah!`,
        autoReplies: [
          { trigger: 'Tanya Stok', response: 'Halo Kak! Seluruh produk yang bisa di-klik siap kirim ya. Silakan langsung di-checkout sebelum kehabisan!' },
          { trigger: 'Pengiriman', response: 'Pesanan masuk sebelum jam 15.00 WIB dikirim di hari yang sama ya Kak. Terima kasih!' },
          { trigger: 'Komplain/Retur', response: 'Mohon sertakan video unboxing utuh saat paket dibuka ya Kak, tim kami siap bantu retur jika ada kendala.' },
        ],
        bannerSlogans: ['Tampil Cantik Setiap Hari', 'Kualitas Butik Harga Terbaik', 'Flash Sale & Promo Eksklusif'],
        message: 'Configure a Gemini API key in Settings to generate dynamic store copy.',
      });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah pakar Customer Experience Shopee Indonesia.
Buatkan deskripsi toko menarik dan 3 template balasan chat CS otomatis untuk toko: "${storeName}".

Kembalikan JSON murni:
{
  "storeBio": "Deskripsi profil toko menarik dan terpercaya maksimal 3 kalimat",
  "autoReplies": [
    { "trigger": "Salam / Tanya Stok", "response": "Template balasan ramah" },
    { "trigger": "Jadwal Kirim", "response": "Template balasan pengiriman" },
    { "trigger": "Garansi / Retur", "response": "Template balasan retur" }
  ],
  "bannerSlogans": ["Slogan 1", "Slogan 2", "Slogan 3"]
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
        storeBio: `Selamat datang di ${storeName}! Toko terpercaya dengan koleksi terbaik.`,
        autoReplies: [],
        bannerSlogans: [],
        message: 'Gemini request failed. Fallback data shown.',
      });
    }
  }

  // 3. FITUR 1: AI Automated Copywriter & A/B Testing Variations Generator
  async generateABTestCopy({ name = '', category = '', price = 0, description = '', targetAudience = 'Wanita Muda & Dewasa' }) {
    if (!this.ai) {
      return this.notConfigured({
        productName: name,
        variations: [
          {
            variantType: 'SEO_OPTIMIZED',
            variantLabel: 'Varian A: Fokus Algoritma SEO Shopee',
            title: `[TERBARU 2026] ${name} Premium - Baju Fashion ${category || 'Wanita'} Modis Nyaman`,
            tagline: 'Meningkatkan visibilitas pencarian organik hingga 2.5x',
            bullets: [
              'Bahan berkualitas tinggi, lembut & tidak menerawang',
              'Jahitan rapi standar butik dengan fitting nyaman',
              'Ready stock & siap kirim ke seluruh Indonesia',
            ],
            shortCopy: `Upgrade penampilanmu dengan ${name}! Dibuat dari material pilihan yang adem dan elegan, cocok untuk hangout maupun acara formal.`,
            recommendedTags: ['#fashionwanita', '#ootd', '#shopeehaul', '#kualitaspremium'],
          },
          {
            variantType: 'PROMO_DRIVEN',
            variantLabel: 'Varian B: Fokus Promo & Urgensi Diskon',
            title: `[FLASH SALE HARI INI] ${name} Diskon Spesial + Gratis Ongkir XTRA!`,
            tagline: 'Memikat pembeli pemburu diskon dengan trigger kelangkaan',
            bullets: [
              'Harga promo terbatas khusus pembelian hari ini',
              'Bisa COD (Bayar di Tempat) & Garansi Retur 100%',
              'Stok promo terbatas, amankan warnamu sekarang!',
            ],
            shortCopy: `Jangan sampai kehabisan! Dapatkan ${name} dengan harga termurah hari ini. Checkout sekarang sebelum promo berakhir!`,
            recommendedTags: ['#flashsale', '#diskonspesial', '#gratisongkir', '#cod'],
          },
          {
            variantType: 'EMOTIONAL_BENEFIT',
            variantLabel: 'Varian C: Fokus Estetika & Kepercayaan Diri',
            title: `Tampil Anggun & Percaya Diri dengan ${name} - Elegan & Lembut di Kulit`,
            tagline: 'Membangun koneksi emosional & estetika feminine',
            bullets: [
              'Desain flattering yang membuat siluet tubuh tampak lebih jenjang',
              'Sensasi bahan sejuk yang nyaman dipakai seharian',
              'Warna aesthetic yang mudah dipadupadankan',
            ],
            shortCopy: `Rasakan kenyamanan maksimal tanpa mengorbankan gaya. ${name} hadir untuk menemani setiap momen spesialmu agar makin percaya diri.`,
            recommendedTags: ['#aestheticoutfit', '#eleganstyle', '#fashioninspo', '#selflove'],
          },
        ],
        confidenceScore: 88,
      });
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

      return {
        success: true,
        provider: 'REAL_GEMINI_API',
        model: this.modelName,
        ...parsed,
      };
    } catch (err) {
      console.warn(`[AI Service] Gemini A/B copy error: ${err.message}`);
      return this.notConfigured({
        productName: name,
        variations: [],
        message: 'Gagal membuat variasi A/B copy. Cek kunci API Gemini.',
      });
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

    if (!this.ai) {
      return this.notConfigured({
        sku,
        productName: name,
        metrics: {
          currentStock: totalPhysicalStock,
          dailyVelocity: Number(dailyVelocity.toFixed(2)),
          daysOfInventory,
          leadTimeDays,
          predictedRunoutDate,
          urgency,
          suggestedBatchReorder,
        },
        restockRecommendation: urgency === 'CRITICAL' || urgency === 'OUT_OF_STOCK'
          ? `Segera terbitkan Purchase Order ${suggestedBatchReorder} unit sebelum kehabisan stok.`
          : 'Stok dalam batas aman untuk 30 hari ke depan.',
        liquidationPlaybook: urgency === 'DEADSTOCK' ? {
          isDeadstock: true,
          clearanceDiscountSuggested: '25% - 35%',
          bundlingIdea: `Bundling 2x ${name} dengan potongan harga spesial atau gift voucher`,
          flashSaleStrategy: 'Ikuti Flash Sale Shopee pada jam peak (12.00 / 19.00 WIB)',
          actionSteps: [
            'Buat Voucher Toko khusus untuk SKU ini',
            'Alokasikan ke flash sale berkala untuk mencairkan modal kerja',
            'Kurangi alokasi restock pada batch berikutnya',
          ],
        } : {
          isDeadstock: false,
          clearanceDiscountSuggested: '0%',
          bundlingIdea: 'Dapat dijadikan kombo hemat dengan produk terlaris',
          flashSaleStrategy: 'Gunakan flash sale sesekali untuk mendorong traffic',
          actionSteps: ['Pantau pergerakan stok harian'],
        },
      });
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

      return {
        success: true,
        provider: 'REAL_GEMINI_API',
        model: this.modelName,
        sku,
        productName: name,
        metrics: {
          currentStock: totalPhysicalStock,
          dailyVelocity: Number(dailyVelocity.toFixed(2)),
          daysOfInventory,
          leadTimeDays,
          predictedRunoutDate,
          urgency,
          suggestedBatchReorder,
        },
        ...parsed,
      };
    } catch (err) {
      console.warn(`[AI Service] Gemini predictive restock error: ${err.message}`);
      return this.notConfigured({
        sku,
        productName: name,
        metrics: {
          currentStock: totalPhysicalStock,
          dailyVelocity: Number(dailyVelocity.toFixed(2)),
          daysOfInventory,
          leadTimeDays,
          predictedRunoutDate,
          urgency,
          suggestedBatchReorder,
        },
        restockRecommendation: 'Pantau persediaan secara berkala.',
        liquidationPlaybook: null,
      });
    }
  }

  // 5. FITUR 3: AI Dynamic Pricing & Profit-Margin Simulator
  async simulateDynamicPricing({ name = '', currentPrice = 0, targetPrice = 0, unitCost = 0, unitAdCost = 0, shippingCost = 0, platformFeePercent = 6.5, competitorPrice = 0 }) {
    const price = Number(targetPrice || currentPrice || 0);
    const cogs = Number(unitCost || 0);
    const adCost = Number(unitAdCost || 0);
    const shipping = Number(shippingCost || 0);
    const feePct = Number(platformFeePercent || 6.5);

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

    if (!this.ai) {
      return this.notConfigured({
        productName: name,
        input: { currentPrice, targetPrice: price, unitCost: cogs, unitAdCost: adCost, shippingCost: shipping, platformFeePercent: feePct, competitorPrice },
        calculations: {
          platformFeeAmount: Math.round(platformFeeAmount),
          totalCost: Math.round(totalCost),
          grossMarginAmount: Math.round(grossMarginAmount),
          grossMarginPercent: Number(grossMarginPercent.toFixed(1)),
          breakevenPrice,
          safetyFloorPrice,
          riskLevel,
        },
        aiAdvice: {
          optimalPrice: Math.max(safetyFloorPrice, competitorPrice ? Math.round(competitorPrice * 0.98) : Math.round(price)),
          elasticityAnalysis: grossMarginAmount > 0 
            ? `Margin saat ini ${grossMarginPercent.toFixed(1)}% (Rp ${Math.round(grossMarginAmount).toLocaleString('id-ID')}/unit). Cukup aman untuk promo voucher.`
            : 'PERINGATAN: Harga ini merugikan operasional setelah potongan fee dan biaya iklan.',
          competitorBenchmarking: competitorPrice
            ? `Harga Anda ${price < competitorPrice ? 'lebih murah' : 'lebih mahal'} dibanding kompetitor (Rp ${Number(competitorPrice).toLocaleString('id-ID')}).`
            : 'Belum ada data harga pembanding kompetitor.',
          promotionalDiscountBudget: Math.max(0, Math.round(grossMarginAmount * 0.4)),
        },
      });
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

      return {
        success: true,
        provider: 'REAL_GEMINI_API',
        model: this.modelName,
        productName: name,
        input: { currentPrice, targetPrice: price, unitCost: cogs, unitAdCost: adCost, shippingCost: shipping, platformFeePercent: feePct, competitorPrice },
        calculations: {
          platformFeeAmount: Math.round(platformFeeAmount),
          totalCost: Math.round(totalCost),
          grossMarginAmount: Math.round(grossMarginAmount),
          grossMarginPercent: Number(grossMarginPercent.toFixed(1)),
          breakevenPrice,
          safetyFloorPrice,
          riskLevel,
        },
        ...parsed,
      };
    } catch (err) {
      console.warn(`[AI Service] Gemini pricing simulator error: ${err.message}`);
      return this.notConfigured({
        productName: name,
        input: { currentPrice, targetPrice: price, unitCost: cogs, unitAdCost: adCost, shippingCost: shipping, platformFeePercent: feePct, competitorPrice },
        calculations: {
          platformFeeAmount: Math.round(platformFeeAmount),
          totalCost: Math.round(totalCost),
          grossMarginAmount: Math.round(grossMarginAmount),
          grossMarginPercent: Number(grossMarginPercent.toFixed(1)),
          breakevenPrice,
          safetyFloorPrice,
          riskLevel,
        },
        aiAdvice: {
          optimalPrice: safetyFloorPrice,
          elasticityAnalysis: 'Simulasi selesai dihitung.',
          competitorBenchmarking: '',
          promotionalDiscountBudget: 0,
        },
      });
    }
  }

  // 6. FITUR 4: AI Automated Daily Store Briefing (Executive Digest)
  async generateDailyBriefing({ storeOverview = {}, adsMetrics = {}, warehouseTotals = {}, topProducts = [] } = {}) {
    const todayStr = new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const gmv = storeOverview?.kpis?.totalGmv || 0;
    const orders = storeOverview?.kpis?.totalOrders || 0;
    const adSpend = adsMetrics?.totalSpend || 0;
    const roas = adsMetrics?.roas || 0;
    const discrepancies = warehouseTotals?.discrepanciesCount || 0;

    if (!this.ai) {
      return this.notConfigured({
        date: todayStr,
        healthScore: roas >= 4 && discrepancies === 0 ? 92 : roas < 2 ? 65 : 80,
        executiveSummary: `Briefing Harian Toko (${todayStr}): Performa toko berjalan stabil dengan total GMV tercatat Rp ${Number(gmv).toLocaleString('id-ID')} dan ROAS iklan ${Number(roas).toFixed(2)}x. Terdeteksi ${discrepancies} selisih stok gudang yang memerlukan verifikasi.`,
        topWinner: topProducts[0]?.name ? `${topProducts[0].name} (${topProducts[0].salesCount} terjual)` : 'Produk Katalog Teratas',
        criticalAlerts: [
          ...(roas > 0 && roas < 2 ? [`Iklan Boncos: ROAS saat ini ${Number(roas).toFixed(2)}x di bawah target aman (3.0x).`] : []),
          ...(discrepancies > 0 ? [`Rekonsiliasi Stok: Terdapat ${discrepancies} SKU dengan selisih stok antara Shopee & Gudang.`] : []),
        ],
        priorityActionsToday: [
          'Tinjau kata kunci kampanye iklan dengan pengeluaran tertinggi untuk memotong kata kunci non-konversi.',
          'Lakukan penyesuaian stok manual untuk SKU yang berselisih di menu Gudang.',
          'Optimalkan judul & deskripsi produk unggulan dengan AI A/B Test Copywriter.',
        ],
        marketOutlook: 'Kategori fashion wanita tetap aktif di jam makan siang (11.00-13.00) dan malam hari (19.00-21.00 WIB).',
      });
    }

    try {
      const parsed = await this.generateJson(`Anda adalah AI Chief Operating Officer (COO) untuk Seller Shopee Indonesia.
Analisis snapshot toko hari ini (${todayStr}):
- Total GMV Terakhir: Rp ${Number(gmv).toLocaleString('id-ID')}
- Total Pesanan: ${orders} pesanan
- Pengeluaran Iklan: Rp ${Number(adSpend).toLocaleString('id-ID')} (ROAS: ${Number(roas).toFixed(2)}x)
- Selisih Stok Multi-Gudang: ${discrepancies} SKU bermasalah
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

      return {
        success: true,
        provider: 'REAL_GEMINI_API',
        model: this.modelName,
        ...parsed,
      };
    } catch (err) {
      console.warn(`[AI Service] Gemini daily briefing error: ${err.message}`);
      return this.notConfigured({
        date: todayStr,
        healthScore: 75,
        executiveSummary: 'Briefing harian dihasilkan dari data snapshot lokal.',
        criticalAlerts: [],
        priorityActionsToday: ['Jalankan sinkronisasi data', 'Tinjau performa iklan harian'],
      });
    }
  }

  // 7. FITUR 5: AI Ads Negative Keyword & Bid Optimization
  async optimizeAdsKeywordsAndBids({ campaignName = 'Shopee Ads', spend = 0, sales = 0, roas = 0, ctr = 0, category = 'Fashion' }) {
    const isUnderperforming = roas > 0 && roas < 2.5;

    if (!this.ai) {
      return this.notConfigured({
        campaignName,
        summary: `Evaluasi Kampanye: Pengeluaran Rp ${Number(spend).toLocaleString('id-ID')}, ROAS ${Number(roas).toFixed(2)}x, CTR ${Number(ctr).toFixed(2)}%.`,
        wastedSpendEstimate: isUnderperforming ? Math.round(Number(spend) * 0.35) : 0,
        negativeKeywordsToExclude: [
          'gratis', 'bekas', 'murahan', 'palsu', 'second', 'tutorial', 'pola jahit',
        ],
        bidAdjustments: [
          { keywordType: 'Kata Kunci Konversi Tinggi (ROAS > 4.0)', action: 'NAIKKAN_BID', recommendedAdjustment: '+15% s/d +20%', reason: 'Tingkatkan pangsa tayang untuk mendominasi peringkat 1-3' },
          { keywordType: 'Kata Kunci Impresi Tinggi Tanpa Klik (CTR < 1%)', action: 'TURUNKAN_BID', recommendedAdjustment: '-25% s/d -30%', reason: 'Kurangi pemborosan impresi tidak relevan' },
          { keywordType: 'Kata Kunci Klik Banyak Tanpa Pesanan (CR = 0%)', action: 'JADIKAN_NEGATIVE', recommendedAdjustment: 'Hapus / Nonaktifkan', reason: 'Menyedot anggaran tanpa menghasilkan GMV' },
        ],
        scaleKeywordsRecommended: [
          { keyword: `${category.toLowerCase()} wanita modis`, matchType: 'Pencocokan Luas', suggestedBid: 850, estimatedSearchVolume: 'Tinggi' },
          { keyword: `${category.toLowerCase()} premium import`, matchType: 'Pencocokan Spesifik', suggestedBid: 1200, estimatedSearchVolume: 'Sedang' },
          { keyword: `baju ${category.toLowerCase()} kekinian`, matchType: 'Pencocokan Luas', suggestedBid: 700, estimatedSearchVolume: 'Tinggi' },
        ],
        dailyBudgetStrategy: isUnderperforming
          ? 'Turunkan budget harian sementara 20% sampai kata kunci boncos dibersihkan.'
          : 'Budget harian optimal, siap dinaikkan bertahap 15% pada akhir pekan.',
      });
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

      return {
        success: true,
        provider: 'REAL_GEMINI_API',
        model: this.modelName,
        ...parsed,
      };
    } catch (err) {
      console.warn(`[AI Service] Gemini ads optimization error: ${err.message}`);
      return this.notConfigured({
        campaignName,
        summary: 'Gagal menganalisis kampanye dengan Gemini.',
        negativeKeywordsToExclude: ['gratis', 'bekas', 'murahan'],
        bidAdjustments: [],
        scaleKeywordsRecommended: [],
      });
    }
  }

  // Backward compatibility methods
  async generateAdsKeywords(campaignName = 'Shopee Ads Campaign') {
    return this.optimizeAdsKeywordsAndBids({ campaignName });
  }
}

module.exports = new AIService();
