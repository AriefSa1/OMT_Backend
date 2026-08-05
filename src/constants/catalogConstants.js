/**
 * Item yang bukan produk jualan, hanya hadiah gratis yang menyertai pembelian lain.
 *
 * Kenapa pola ini spesifik "free gift" dan bukan sekadar "gift": dua produk sah di katalog
 * ini menyebut "+ Gift" pada namanya ("... Blouse + Celana + Hijab + Gift") — itu setelan
 * asli yang kebetulan berbonus, dengan 248 dan 41 penjualan. Yang benar-benar item gratisan
 * adalah "Spesial Free GIFT Random||(tas,kaca bulat,ikat rambut,hijab)" dengan ~6.954
 * "penjualan" — angka yang mendominasi daftar terlaris dan pangsa kategori padahal tidak
 * mewakili penjualan produk sungguhan.
 *
 * Pola dicocokkan ke nama produk, case-insensitive. Menambah pola di sini otomatis
 * mengecualikan item dari daftar produk teratas dan perhitungan pangsa kategori di
 * dashboard — bukan menghapusnya dari katalog (produknya tetap ada di /shopee).
 */
const GIFT_ITEM_PATTERNS = [
  /free\s*gift/i,
];

function isGiftItem(product) {
  const name = String(product?.name || '');
  return GIFT_ITEM_PATTERNS.some((pattern) => pattern.test(name));
}

module.exports = { GIFT_ITEM_PATTERNS, isGiftItem };
