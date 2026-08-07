function number(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Splits a newest-first (descending by date) row list into the "current" and
 * "previous" period slices for a given period selector. Day counts are verified
 * against Shopee's own Ads dashboard, not assumed:
 *  - past7days  = today + 6 prior days (7 days total)
 *  - past30days = today + 31 prior days (32 days) — Shopee's "1 Bulan Terakhir" is
 *    actually 32 days, not a strict 30.
 * Centralized here because snapshotService and the ads controller both need the
 * exact same slicing to stay consistent.
 */
function getPeriodSlices(period, descRows) {
  const rows = descRows || [];
  switch (period) {
    case 'yesterday':
      return { current: rows.slice(1, 2), previous: rows.slice(2, 3) };
    case 'last_week':
    case 'past7days':
      return { current: rows.slice(0, 7), previous: rows.slice(7, 14) };
    case 'last_month':
    case 'past30days':
      return { current: rows.slice(0, 32), previous: rows.slice(32, 64) };
    default:
      // real_time
      return { current: rows.slice(0, 1), previous: rows.slice(1, 2) };
  }
}

function aggregateAdsRows(rows) {
  if (!rows || rows.length === 0) return null;
  const spend = rows.reduce((sum, r) => sum + number(r.spend), 0);
  const sales = rows.reduce((sum, r) => sum + number(r.sales), 0);
  const impressions = rows.reduce((sum, r) => sum + number(r.impressions), 0);
  const clicks = rows.reduce((sum, r) => sum + number(r.clicks), 0);
  const orders = rows.reduce((sum, r) => sum + number(r.orders), 0);
  const itemSold = rows.reduce((sum, r) => sum + number(r.itemSold), 0);
  const roas = spend > 0 ? sales / spend : 0;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const dateStr = rows.length === 1 ? rows[0].date : `${rows[rows.length - 1].date} - ${rows[0].date}`;
  return { spend, sales, roas, impressions, clicks, orders, itemSold, ctr, date: dateStr };
}

function compareAdsMetric(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return { current: current ?? null, previous: previous ?? null, direction: null, changePercent: null };
  }
  const delta = number(current) - number(previous);
  return {
    current: number(current),
    previous: number(previous),
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    changePercent: number(previous) === 0 ? null : (delta / Math.abs(number(previous))) * 100,
  };
}

module.exports = { getPeriodSlices, aggregateAdsRows, compareAdsMetric };
