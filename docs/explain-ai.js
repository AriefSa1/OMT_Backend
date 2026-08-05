/**
 * Runnable explainer for the AI feature — what each piece does and how to change it,
 * without needing to open a file first.
 *
 *   npm run docs:ai
 *
 * The full written reference lives alongside this script in docs/AI_SERVICE.md.
 */

const SECTIONS = [
  {
    title: 'File apa yang mana',
    lines: [
      'src/services/aiService.js       — semua logika AI: 5 fungsi FITUR + retry/klasifikasi error Gemini',
      'src/controllers/aiController.js — jembatan HTTP -> aiService, mengurai body request',
      'src/routes/aiRoutes.js          — 5 rute, semuanya di belakang authMiddleware',
      'test-ai-suite.js                — regresi ter-mock, TIDAK memanggil Gemini sungguhan',
      'docs/AI_SERVICE.md              — referensi lengkap (baca ini untuk detail)',
    ],
  },
  {
    title: '5 fungsi AI',
    lines: [
      '1. generateABTestCopy          <- POST /api/ai/ab-copy',
      '2. predictRestockAndLiquidation <- POST /api/ai/predictive-restock  (wajib: warehouseStock)',
      '3. simulateDynamicPricing       <- POST /api/ai/pricing-simulator   (wajib: platformFeePercent)',
      '4. generateDailyBriefing        <- GET/POST /api/ai/daily-briefing',
      '5. optimizeAdsKeywordsAndBids   <- POST /api/ai/ads-keyword-optimization',
    ],
  },
  {
    title: 'Kenapa fitur AI sering gagal',
    lines: [
      'Kuota Gemini free tier di kunci ini: 20 permintaan/hari untuk gemini-2.5-flash.',
      'Setiap 429 (RESOURCE_EXHAUSTED) sekarang di-retry otomatis (maks 2x) — kalau',
      'tetap gagal setelah itu, respons membawa errorCode "RATE_LIMITED" dengan pesan',
      'yang jelas, bukan pesan generik "gagal".',
      '',
      'Briefing harian di-cache 10 menit di frontend (lib/api.js) supaya sekadar',
      'membuka dashboard tidak menghabiskan kuota harian dengan sendirinya.',
    ],
  },
  {
    title: 'Amplop respons (jangan ubah nama field tanpa mengubah AIStatusNotice.jsx)',
    lines: [
      '{ success:false, provider:"NOT_CONFIGURED", model, message, ...trusted }',
      '{ success:false, provider:"MISSING_INPUT",  model, message, ...trusted }',
      '{ success:false, provider:"ERROR", errorCode, model, message, ...trusted, ...fallbackPayload }',
      '{ success:true,  provider:"REAL_GEMINI_API", model, ...trusted, ...parsedModelOutput }',
    ],
  },
  {
    title: 'Cara mengubah sesuatu',
    lines: [
      '- Ubah prompt/format satu fitur   -> edit string prompt di fungsi FITUR terkait di aiService.js',
      '- Ubah field yg diterima dari body -> edit pickArgs di aiController.js (fungsi aiEndpoint)',
      '- Tambah fitur AI baru             -> tulis method baru di AIService, lalu satu baris',
      '                                      aiEndpoint(...) di aiController.js, lalu daftarkan rute',
      '- Ubah jumlah retry / batas tunggu -> generateJson({ maxRetries }) di aiService.js',
      '- Ganti model                      -> this.modelName di constructor AIService',
      '- Ganti kunci API saat runtime     -> lewat halaman Pengaturan, BUKAN edit .env',
      '',
      'Detail lengkap tiap poin ada di docs/AI_SERVICE.md.',
    ],
  },
  {
    title: 'Menguji',
    lines: [
      'npm run test:ai   — 14 pemeriksaan logika, TIDAK memanggil Gemini, aman dijalankan berkali-kali',
      '',
      'Jangan tambahkan skrip tes yang memanggil Gemini sungguhan — itulah yang dulu',
      'menghabiskan kuota 20/hari hanya dengan menjalankan "tes".',
    ],
  },
];

for (const section of SECTIONS) {
  console.log('');
  console.log(`== ${section.title} ==`);
  console.log('-'.repeat(section.title.length + 6));
  for (const line of section.lines) console.log(line ? `  ${line}` : '');
}

console.log('');
console.log('Referensi lengkap: docs/AI_SERVICE.md');
console.log('');
