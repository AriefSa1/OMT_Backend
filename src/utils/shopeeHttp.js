/**
 * Lapisan keandalan untuk request keluar ke Seller Center.
 *
 * Tujuannya BUKAN mengelabui deteksi bot Shopee, melainkan berperilaku sebagai
 * klien yang tertib sehingga sesi tidak gampang diblokir dan sinkronisasi tidak
 * gagal karena gangguan sesaat:
 *
 *  1. Throttle: jarak minimum antar-request keluar (+ jitter kecil) supaya sync
 *     tidak menghantam endpoint dalam burst. Antrian serial sederhana per-proses.
 *  2. Backoff: retry eksponensial untuk error jaringan / 5xx / 429, MENGHORMATI
 *     header Retry-After bila ada. 4xx selain 429 tidak di-retry (permintaan yang
 *     memang ditolak tidak akan membaik dengan diulang).
 *  3. Timeout tetap diteruskan apa adanya dari pemanggil.
 *
 * Semua nilai bisa disetel lewat env; default aman untuk Render free tier.
 */
const axios = require('axios');

const MIN_INTERVAL_MS = Number(process.env.SHOPEE_MIN_INTERVAL_MS) || 800;
const JITTER_MS = Number(process.env.SHOPEE_JITTER_MS) || 400;
const MAX_RETRIES = Number(process.env.SHOPEE_MAX_RETRIES) || 3;
const BASE_BACKOFF_MS = Number(process.env.SHOPEE_BASE_BACKOFF_MS) || 1000;
const MAX_BACKOFF_MS = Number(process.env.SHOPEE_MAX_BACKOFF_MS) || 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gerbang throttle serial: setiap request menunggu gilirannya, dan gilirannya
// paling cepat MIN_INTERVAL_MS setelah request sebelumnya dilepas.
let gate = Promise.resolve();
let lastReleaseAt = 0;

function acquireSlot() {
  const mine = gate.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastReleaseAt + MIN_INTERVAL_MS - now);
    const jitter = Math.floor(Math.random() * JITTER_MS);
    if (wait + jitter > 0) await sleep(wait + jitter);
    lastReleaseAt = Date.now();
  });
  // Rantai gate ke penyelesaian slot ini, telan error agar antrian tak macet.
  gate = mine.catch(() => {});
  return mine;
}

function isRetriable(err) {
  const status = err.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (!err.response) return true; // error jaringan / timeout / DNS
  return false;
}

function retryAfterMs(err, attempt) {
  const header = err.response?.headers?.['retry-after'];
  if (header) {
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds)) return Math.min(asSeconds * 1000, MAX_BACKOFF_MS);
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) return Math.min(Math.max(0, asDate - Date.now()), MAX_BACKOFF_MS);
  }
  const expo = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * BASE_BACKOFF_MS);
  return Math.min(expo + jitter, MAX_BACKOFF_MS);
}

/**
 * Pengganti drop-in untuk axios(config). Terapkan throttle + retry.
 * Pakai: shopeeRequest({ method: 'get', url, headers, timeout })
 */
async function shopeeRequest(config) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await acquireSlot();
    try {
      return await axios(config);
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_RETRIES || !isRetriable(err)) break;
      const delay = retryAfterMs(err, attempt);
      const status = err.response?.status || err.code || 'network';
      console.warn(
        `[shopeeHttp] ${config.method || 'get'} ${String(config.url).split('?')[0]} gagal (${status}), ` +
        `retry ${attempt + 1}/${MAX_RETRIES} dalam ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { shopeeRequest };
