/**
 * Enkripsi kredensial (cookie Shopee) saat disimpan di database — AES-256-GCM.
 *
 * Kenapa: cookie Seller Center adalah token sesi hidup. Menyimpannya sebagai
 * plaintext berarti siapa pun yang membaca DB (dump, backup bocor, atau — seperti
 * yang sudah terjadi di repo ini — riwayat git yang bocor) langsung memegang sesi
 * penuh. GCM memberi kerahasiaan sekaligus integritas (auth tag), jadi ciphertext
 * yang diubah akan ditolak, bukan mendekripsi jadi sampah diam-diam.
 *
 * Kunci diambil dari env CREDENTIAL_ENC_KEY: 64 hex char (32 byte) atau base64.
 * Format tersimpan: `enc:v1:<ivHex>:<tagHex>:<ciphertextHex>`.
 *
 * Kompatibilitas migrasi: decrypt() mengembalikan nilai apa adanya bila tidak
 * berformat enc: — sehingga baris plaintext lama tetap terbaca sampai ditimpa
 * (di-save ulang) dalam bentuk terenkripsi. Gunakan needsEncryption() untuk
 * mendeteksi baris lama yang perlu di-migrasi.
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.CREDENTIAL_ENC_KEY;
  if (!raw) {
    throw new Error(
      'CREDENTIAL_ENC_KEY belum diset. Buat dengan: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENC_KEY harus 32 byte (64 hex char atau base64 setara).');
  }
  cachedKey = key;
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** True bila value ada tapi belum terenkripsi (baris plaintext lama). */
function needsEncryption(value) {
  return typeof value === 'string' && value.length > 0 && !isEncrypted(value);
}

function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('encrypt() butuh string non-kosong.');
  }
  const key = loadKey();
  const iv = crypto.randomBytes(12); // 96-bit IV standar untuk GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(stored) {
  if (typeof stored !== 'string' || !stored) return '';
  // Baris plaintext lama (pra-enkripsi) — kembalikan apa adanya untuk migrasi mulus.
  if (!isEncrypted(stored)) return stored;

  const body = stored.slice(PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('Format ciphertext kredensial tidak valid.');
  }
  const [ivHex, tagHex, ctHex] = parts;
  const key = loadKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted, needsEncryption };
