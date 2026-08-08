/**
 * Resolusi rentang tanggal terpusat — SATU tempat untuk mengubah input tanggal
 * (dari date range picker frontend) menjadi epoch yang dibutuhkan tiap endpoint.
 *
 * Kenapa terpusat: Shopee memakai epoch **detik**, sedangkan Gudang (PDC) memakai
 * epoch **milidetik**. Batas hari harus mengikuti zona **Asia/Jakarta (WIB, UTC+7,
 * tanpa DST)**, bukan UTC. Menaruh konversi ini di banyak controller = sumber bug
 * ms-vs-detik dan salah-hari. Semua lewat sini.
 *
 * Frontend mengirim tanggal ISO `YYYY-MM-DD` (bukan epoch) supaya konversi & zona
 * waktu ditangani backend.
 */

const MS_PER_DAY = 86_400_000;
const WIB_OFFSET = '+07:00';
const DEFAULT_MAX_DAYS = 90;

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Awal hari (00:00:00 WIB) dari 'YYYY-MM-DD' → epoch ms. NaN bila tak valid. */
function startOfDayMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00.000${WIB_OFFSET}`);
}

/** Akhir hari (23:59:59.999 WIB) dari 'YYYY-MM-DD' → epoch ms. NaN bila tak valid. */
function endOfDayMs(dateStr) {
  return Date.parse(`${dateStr}T23:59:59.999${WIB_OFFSET}`);
}

/**
 * Kembalikan { start, end, unit, source } sesuai satuan endpoint.
 *
 * @param {object} o
 * @param {string} [o.startDate] 'YYYY-MM-DD' (WIB)
 * @param {string} [o.endDate]   'YYYY-MM-DD' (WIB)
 * @param {number} [o.days]      fallback bila tanggal tak lengkap (default 30)
 * @param {'sec'|'ms'} [o.unit]  satuan keluaran (Shopee='sec', Gudang='ms')
 * @param {number} [o.maxDays]   batas rentang maksimum (default 90)
 *
 * Bila startDate/endDate tak lengkap/valid → pakai `days` mundur dari sekarang
 * (kompatibel dengan perilaku lama). start>end otomatis ditukar. Rentang melebihi
 * maxDays dipangkas dari sisi end.
 */
function resolveRange({ startDate, endDate, days, unit = 'sec', maxDays = DEFAULT_MAX_DAYS } = {}) {
  let startMs;
  let endMs;
  let source;

  if (isIsoDate(startDate) && isIsoDate(endDate)) {
    // Ambil batas hari kedua tanggal, lalu pilih yang paling awal sebagai start dan
    // paling akhir sebagai end — jadi urutan input terbalik pun tetap benar.
    const aStart = startOfDayMs(startDate);
    const bStart = startOfDayMs(endDate);
    const aEnd = endOfDayMs(startDate);
    const bEnd = endOfDayMs(endDate);
    if ([aStart, bStart, aEnd, bEnd].every(Number.isFinite)) {
      startMs = Math.min(aStart, bStart);
      endMs = Math.max(aEnd, bEnd);
      const spanDays = Math.round((endMs - startMs) / MS_PER_DAY);
      if (maxDays && spanDays > maxDays) {
        startMs = endMs - maxDays * MS_PER_DAY;
      }
      source = 'range';
    }
  }

  if (source !== 'range') {
    const safeDays = Math.min(maxDays || 3650, Math.max(1, Number(days) || 30));
    endMs = Date.now();
    startMs = endMs - safeDays * MS_PER_DAY;
    source = 'days';
  }

  const divisor = unit === 'ms' ? 1 : 1000;
  return {
    start: Math.floor(startMs / divisor),
    end: Math.floor(endMs / divisor),
    unit,
    source,
  };
}

/**
 * Tebak `period` Shopee dari rentang, untuk endpoint yang butuh label period
 * (key-metrics, product overview, dll). Konservatif: petakan ke bucket yang didukung.
 */
function derivePeriod(startDate, endDate) {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return null;
  const spanDays = Math.round((endOfDayMs(endDate) - startOfDayMs(startDate)) / MS_PER_DAY);
  if (spanDays <= 1) return 'day';
  if (spanDays <= 7) return 'past7days';
  return 'past30days';
}

module.exports = { resolveRange, derivePeriod, isIsoDate, startOfDayMs, endOfDayMs };
