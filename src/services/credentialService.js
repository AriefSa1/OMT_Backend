/**
 * Pengelolaan kredensial Shopee terpusat (dikelola admin).
 *
 * Cookie disimpan terenkripsi (AES-256-GCM, lihat utils/credentialCrypto). Cookie
 * mentah TIDAK PERNAH keluar lewat endpoint list — hanya metadata. Satu-satunya
 * jalur cookie dekripsi keluar adalah resolveCookie(), dipakai internal oleh
 * shopeeService saat menyusun request keluar ke Seller Center.
 *
 * Skema penyimpanan: ShopeeCredential dengan storeId unik. Kredensial global
 * disimpan dengan storeId sentinel GLOBAL_KEY.
 */
const prisma = require('../utils/prisma');
const { encrypt, decrypt } = require('../utils/credentialCrypto');

const GLOBAL_KEY = 'global';

function keyFor(storeId) {
  return storeId ? String(storeId) : GLOBAL_KEY;
}

/** Simpan / perbarui cookie untuk satu store (atau global). Selalu terenkripsi. */
async function saveCredential(cookie, storeId = null) {
  const key = keyFor(storeId);
  const ciphertext = encrypt(cookie);
  return prisma.shopeeCredential.upsert({
    where: { storeId: key },
    update: { cookie: ciphertext, storeId: key },
    create: { cookie: ciphertext, storeId: key },
  });
}

/** Metadata saja — cookie sengaja tidak disertakan. */
async function listCredentials() {
  return prisma.shopeeCredential.findMany({
    select: { id: true, storeId: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function deleteCredential(id) {
  return prisma.shopeeCredential.delete({ where: { id: Number(id) } });
}

/**
 * Kembalikan cookie terdekripsi untuk store tertentu, jatuh ke kredensial global
 * bila store tidak punya sendiri. '' bila tidak ada. Dipakai sebagai fallback oleh
 * shopeeService — bukan sumber utama bila sesi per-store sudah punya cookie.
 */
async function resolveCookie(storeId = null) {
  const candidates = storeId ? [String(storeId), GLOBAL_KEY] : [GLOBAL_KEY];
  for (const key of candidates) {
    const cred = await prisma.shopeeCredential.findUnique({ where: { storeId: key } });
    if (cred?.cookie) {
      try {
        return decrypt(cred.cookie);
      } catch (err) {
        console.error(`[credentialService] Gagal dekripsi credential storeId=${key}:`, err.message);
      }
    }
  }
  return '';
}

module.exports = { saveCredential, listCredentials, deleteCredential, resolveCookie, GLOBAL_KEY };
