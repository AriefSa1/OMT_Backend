const SKILLS = Object.freeze({
  IKLAN: Object.freeze({
    id: 'ads-performance-analyst',
    version: '1.0.0',
    label: 'Ads Performance Analyst',
    requiredEvidence: ['spend', 'sales', 'roas', 'impressions', 'clicks', 'ctr'],
    instructions: [
      'Pisahkan masalah exposure (impressions), engagement (clicks/CTR), dan conversion (sales/orders).',
      'Bandingkan campaign berdasarkan spend, sales, ROAS, dan CTR; jangan menganggap ROAS tinggi berarti profit tinggi.',
      'Jangan menyarankan kenaikan budget tanpa HPP, biaya marketplace, atau eksperimen yang dapat diukur.',
      'Prioritaskan tindakan yang dapat diuji dalam periode pendek dan sebutkan metrik keberhasilannya.',
    ],
    blockedClaims: ['profit', 'rugi', 'margin', 'forecast tanpa data', 'kenaikan budget sebagai kepastian'],
  }),
  PERFORMA_TOKO: Object.freeze({
    id: 'store-funnel-analyst',
    version: '1.0.0',
    label: 'Store Funnel Analyst',
    requiredEvidence: ['confirmedGmv', 'confirmedBuyers', 'confirmedUnits', 'visitors'],
    instructions: [
      'Gunakan Product Overview confirmed sebagai sumber kanonik level toko.',
      'Bedakan placed dan confirmed; jangan menyamakan buyer unik toko dengan agregat buyer produk.',
      'Jangan membuat cancellation rate apabila denominator tidak tersedia.',
      'Jelaskan funnel yang terukur dan tandai bagian funnel yang belum memiliki bukti.',
    ],
    blockedClaims: ['cancellation rate tanpa denominator', 'rating tanpa sumber', 'fulfillment speed tanpa sumber', 'causal claim tanpa eksperimen'],
  }),
  PERFORMA_PRODUK: Object.freeze({
    id: 'product-portfolio-analyst',
    version: '1.0.0',
    label: 'Product Portfolio Analyst',
    requiredEvidence: ['confirmedSales', 'confirmedUnits'],
    instructions: [
      'Gunakan Product Performance sebagai sumber grain produk dan Product Overview confirmed untuk rekonsiliasi core total.',
      'Gunakan GMV dan unit sebagai core total yang sudah direkonsiliasi.',
      'Labeli orders, buyers, views, dan visitors sebagai agregat grain produk; jangan menyamakannya dengan metrik unik level toko.',
      'Cari konsentrasi revenue, produk dengan traffic tinggi tetapi conversion rendah, dan produk yang layak diuji lebih lanjut.',
      'Jangan menyatakan tren tanpa dua periode lengkap yang comparable.',
    ],
    blockedClaims: ['buyer unik toko dari agregat produk', 'UV toko dari penjumlahan UV produk', 'profit tanpa biaya', 'stok sellable tanpa mapping'],
  }),
});

function getSkill(intent) {
  return SKILLS[intent] || null;
}

function listSkills() {
  return Object.values(SKILLS).map(({ id, version, label }) => ({ id, version, label }));
}

module.exports = { SKILLS, getSkill, listSkills };
