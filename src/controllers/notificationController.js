const prisma = require('../utils/prisma');
const { wrapHandlers } = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');

/**
 * Ringkasan config notifikasi ditampilkan ke admin. URL webhook Discord tergolong rahasia
 * (siapa pun yang punya bisa mem-posting ke channel itu), jadi nilainya TIDAK dikembalikan
 * utuh — hanya penanda "sudah diisi" + potongan akhir untuk identifikasi. Untuk mengubah,
 * admin mengirim nilai baru; mengirim string kosong berarti mengosongkan.
 */
function maskTail(value, keep = 6) {
  if (!value) return null;
  const tail = String(value).slice(-keep);
  return `…${tail}`;
}

function presentConfig(config) {
  if (!config) {
    return { discordConfigured: false, telegramConfigured: false, whatsappConfigured: false, isActive: true };
  }
  return {
    discordConfigured: Boolean(config.discordWebhookUrl),
    discordHint: maskTail(config.discordWebhookUrl),
    telegramConfigured: Boolean(config.telegramChatId),
    telegramChatId: config.telegramChatId || null, // chat id bukan rahasia, tampilkan penuh
    whatsappConfigured: Boolean(config.whatsappNumber),
    whatsappNumber: config.whatsappNumber || null,
    isActive: config.isActive
  };
}

/** GET /api/admin/notifications/channels — daftar kanal + kesiapannya di server. */
async function getChannels(req, res) {
  return res.json({ success: true, data: { channels: notificationService.listChannels() } });
}

/** GET /api/admin/notifications/config/:userId */
async function getUserConfig(req, res) {
  const { userId } = req.params;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
  if (!user) return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
  const config = await notificationService.getConfig(userId);
  return res.json({ success: true, data: { user, config: presentConfig(config) } });
}

/** PUT /api/admin/notifications/config/:userId — set/ubah tujuan kanal. */
async function updateUserConfig(req, res) {
  const { userId } = req.params;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
  if (!user) return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });

  const { discordWebhookUrl, telegramChatId, whatsappNumber, isActive } = req.body || {};

  // Field yang tidak dikirim (undefined) dibiarkan; string kosong berarti dikosongkan.
  const data = {};
  if (discordWebhookUrl !== undefined) {
    const val = String(discordWebhookUrl).trim();
    if (val && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(val)) {
      return res.status(400).json({ success: false, error: 'URL webhook Discord tidak valid.' });
    }
    data.discordWebhookUrl = val || null;
  }
  if (telegramChatId !== undefined) data.telegramChatId = String(telegramChatId).trim() || null;
  if (whatsappNumber !== undefined) data.whatsappNumber = String(whatsappNumber).trim() || null;
  if (isActive !== undefined) data.isActive = Boolean(isActive);

  const config = await prisma.notificationConfig.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data }
  });

  return res.json({ success: true, data: { config: presentConfig(config) } });
}

function validateSendBody(body) {
  const message = String(body?.message || '').trim();
  if (!message) return { error: 'Pesan tidak boleh kosong.' };
  const channels = Array.isArray(body?.channels) ? body.channels.filter(Boolean) : [];
  if (!channels.length) return { error: 'Pilih minimal satu kanal.' };
  return { message, subject: String(body?.subject || '').trim() || null, channels };
}

/** POST /api/admin/notifications/send — kirim pesan ke satu pengguna. */
async function sendNotification(req, res) {
  const { userId } = req.body || {};
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
  if (!user) return res.status(404).json({ success: false, error: 'Pengguna tujuan tidak ditemukan.' });

  const parsed = validateSendBody(req.body);
  if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });

  const results = await notificationService.sendToUser({
    user,
    channels: parsed.channels,
    subject: parsed.subject,
    message: parsed.message,
    actor: req.user
  });

  const anySent = results.some((r) => r.status === 'SENT');
  return res.json({ success: anySent, data: { results }, message: anySent ? 'Pesan terkirim.' : 'Semua kanal gagal. Lihat detail.' });
}

/** POST /api/admin/notifications/test — kirim pesan uji singkat. */
async function sendTest(req, res) {
  const { userId, channels } = req.body || {};
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
  if (!user) return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan.' });
  const chosen = Array.isArray(channels) && channels.length ? channels.filter(Boolean) : undefined;

  const results = await notificationService.sendToUser({
    user,
    channels: chosen,
    subject: 'Uji Notifikasi',
    message: `Ini pesan uji dari panel admin untuk ${user.name || user.email}. Bila Anda menerimanya, kanal notifikasi berfungsi.`,
    actor: req.user
  });

  const anySent = results.some((r) => r.status === 'SENT');
  return res.json({ success: anySent, data: { results } });
}

/** GET /api/admin/notifications/logs?limit=50 */
async function getLogs(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const logs = await prisma.notificationLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit
  });
  return res.json({ success: true, data: { logs } });
}

module.exports = wrapHandlers({
  getChannels,
  getUserConfig,
  updateUserConfig,
  sendNotification,
  sendTest,
  getLogs
});
