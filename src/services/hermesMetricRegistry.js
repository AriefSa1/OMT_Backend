const METRIC_REGISTRY = Object.freeze({
  IKLAN: Object.freeze({
    spend: { unit: 'IDR', direction: 'DECREASE_OR_BALANCE', label: 'Spend iklan' },
    sales: { unit: 'IDR', direction: 'INCREASE', label: 'Sales iklan' },
    roas: { unit: 'x', direction: 'INCREASE', label: 'ROAS' },
    impressions: { unit: 'count', direction: 'INCREASE_OR_BALANCE', label: 'Impressions' },
    clicks: { unit: 'count', direction: 'INCREASE_OR_BALANCE', label: 'Clicks' },
    ctr: { unit: '%', direction: 'INCREASE', label: 'CTR' },
    orders: { unit: 'count', direction: 'INCREASE', label: 'Orders iklan' },
    itemSold: { unit: 'count', direction: 'INCREASE', label: 'Item terjual dari iklan' },
  }),
  PERFORMA_TOKO: Object.freeze({
    confirmedGmv: { unit: 'IDR', direction: 'INCREASE', label: 'Confirmed GMV' },
    confirmedBuyers: { unit: 'count', direction: 'INCREASE', label: 'Confirmed buyers' },
    confirmedUnits: { unit: 'count', direction: 'INCREASE', label: 'Confirmed units' },
    visitors: { unit: 'count', direction: 'INCREASE_OR_BALANCE', label: 'Visitors' },
  }),
  PERFORMA_PRODUK: Object.freeze({
    confirmedSales: { unit: 'IDR', direction: 'INCREASE', label: 'Confirmed sales' },
    confirmedOrders: { unit: 'count', direction: 'INCREASE', label: 'Confirmed orders' },
    confirmedUnits: { unit: 'count', direction: 'INCREASE', label: 'Confirmed units' },
    confirmedBuyers: { unit: 'count', direction: 'INCREASE', label: 'Confirmed buyers agregat produk' },
    views: { unit: 'count', direction: 'INCREASE_OR_BALANCE', label: 'Views agregat produk' },
    visitors: { unit: 'count', direction: 'INCREASE_OR_BALANCE', label: 'Visitors agregat produk' },
    averageConversionRate: { unit: '%', direction: 'INCREASE', label: 'Average conversion rate' },
  }),
});

const ALIASES = Object.freeze({
  IKLAN: Object.freeze({ roas: 'roas', ctr: 'ctr' }),
  PERFORMA_TOKO: Object.freeze({ gmv: 'confirmedGmv', sales: 'confirmedGmv', units: 'confirmedUnits', buyers: 'confirmedBuyers' }),
  PERFORMA_PRODUK: Object.freeze({ sales: 'confirmedSales', units: 'confirmedUnits', orders: 'confirmedOrders' }),
});

function normalizeMetricKey(intent, value) {
  const key = String(value || '').trim();
  if (!key) return null;
  return ALIASES[intent]?.[key] || key;
}

function getMetricDefinition(intent, metricKey) {
  const normalized = normalizeMetricKey(intent, metricKey);
  return normalized ? METRIC_REGISTRY[intent]?.[normalized] || null : null;
}

function listMetrics(intent) {
  return Object.entries(METRIC_REGISTRY[intent] || {}).map(([key, definition]) => ({ key, ...definition }));
}

function validateTrackingConfig({ intent, metricKey, baselineValue, targetValue, unit, windowDays } = {}) {
  const normalizedMetricKey = normalizeMetricKey(intent, metricKey);
  const definition = getMetricDefinition(intent, normalizedMetricKey);
  const errors = [];
  const warnings = [];
  if (intent && metricKey && !definition) errors.push(`metricKey ${String(metricKey)} tidak terdaftar untuk intent ${intent}.`);
  if (definition && unit && unit !== definition.unit) errors.push(`Unit ${unit} tidak sesuai untuk ${normalizedMetricKey}; gunakan ${definition.unit}.`);
  if (windowDays !== undefined && windowDays !== null && ![7, 30].includes(Number(windowDays))) errors.push('windowDays hanya boleh 7 atau 30.');
  if (normalizedMetricKey && baselineValue === null) warnings.push('Baseline numerik belum tersedia; outcome tidak dapat dievaluasi.');
  if (normalizedMetricKey && targetValue !== null && baselineValue !== null && Number(targetValue) === Number(baselineValue)) warnings.push('Target sama dengan baseline; evaluasi hanya dapat menyatakan perubahan, bukan improvement.');
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metricKey: normalizedMetricKey,
    definition,
  };
}

module.exports = {
  METRIC_REGISTRY,
  normalizeMetricKey,
  getMetricDefinition,
  listMetrics,
  validateTrackingConfig,
};
