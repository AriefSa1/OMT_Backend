/**
 * Pembuat CSV minimal yang aman untuk Excel dan Google Sheets.
 *
 * - Setiap sel yang memuat koma, tanda kutip, atau baris baru dibungkus tanda kutip, dan
 *   tanda kutip di dalamnya digandakan (aturan RFC 4180).
 * - Diawali BOM UTF-8 supaya Excel di Windows membaca karakter non-ASCII (mis. "×", huruf
 *   beraksen) dengan benar alih-alih menampilkannya rusak.
 * - Nilai numerik yang diawali tanda dibiarkan apa adanya; pemformatan angka diserahkan ke
 *   pemanggil supaya ia yang menentukan pembulatan.
 */
function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv, escapeCell };
