/**
 * Index dokumentasi backend — jalankan tanpa argumen untuk daftar lengkap.
 *
 *   npm run docs
 */
const DOCS = [
  { file: 'docs/ARCHITECTURE.md', desc: 'Alur permintaan, lapisan kode, model data, alur Sync' },
  { file: 'docs/API_REFERENCE.md', desc: 'Setiap endpoint: field respons, sumbernya, cara mengubahnya' },
  { file: 'docs/VALUES_AND_THRESHOLDS.md', desc: 'Konstanta bisnis (ambang, bobot, divisor) dan lokasinya' },
  { file: 'docs/AI_SERVICE.md', desc: 'Fitur AI: 5 fungsi, retry/kuota Gemini, cara mengubah prompt' },
  { file: 'docs/DEPLOYMENT.md', desc: 'Rencana deploy Render + Hostinger, migrasi basis data, dan blokir keamanan' },
  { file: 'AGENTS.md', desc: 'Panduan repo: konvensi, constraint data, riwayat pekerjaan' },
];

console.log('\n== Dokumentasi backend ==\n');
for (const { file, desc } of DOCS) console.log(`  ${file}\n    ${desc}\n`);
console.log('Ringkasan cepat fitur AI di terminal: npm run docs:ai');
console.log('');
