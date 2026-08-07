const axios = require('axios');
const prisma = require('../utils/prisma');

/**
 * Pengiriman notifikasi ke pengguna lewat beberapa kanal. Kanal didaftarkan di satu registry
 * `CHANNELS` sehingga menambah kanal baru (mis. WhatsApp) cukup menambah satu entri — sisa
 * pipeline (validasi config, kirim, catat log) tidak berubah.
 *
 * Setiap kanal punya:
 *  - configField: nama kolom di NotificationConfig yang menyimpan tujuan pengguna
 *  - isConfigured(config): apakah pengguna sudah punya tujuan untuk kanal ini
 *  - available(): apakah prasyarat sisi server terpenuhi (mis. token bot global)
 *  - send(destination, payload): benar-benar mengirim; melempar bila gagal
 */

const HTTP_TIMEOUT_MS = 10000;

function formatText({ subject, message, fileUrl }) {
  const text = subject ? `${subject}\n\n${message}` : message;
  return fileUrl ? `${text}\n\nLampiran: ${fileUrl}` : text;
}

const CHANNELS = {
  discord: {
    id: 'discord',
    label: 'Discord',
    configField: 'discordWebhookUrl',
    isConfigured: (config) => Boolean(config?.discordWebhookUrl),
    available: () => true, // webhook per-user, tidak butuh secret global
    async send(destination, payload) {
      // Discord webhook: field `content`, batas 2000 karakter. Subjek ditebalkan.
      const content = payload.subject ? `**${payload.subject}**\n${payload.message}` : payload.message;
      const contentWithAttachment = payload.fileUrl ? `${content}\n\nLampiran: ${payload.fileUrl}` : content;
      await axios.post(destination, { content: contentWithAttachment.slice(0, 1990) }, { timeout: HTTP_TIMEOUT_MS });
    }
  },
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    configField: 'telegramChatId',
    isConfigured: (config) => Boolean(config?.telegramChatId),
    available: () => Boolean(process.env.TELEGRAM_BOT_TOKEN),
    async send(destination, payload) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        const err = new Error('TELEGRAM_BOT_TOKEN belum diset di server.');
        err.code = 'CHANNEL_UNAVAILABLE';
        throw err;
      }
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { chat_id: destination, text: formatText(payload).slice(0, 4000) },
        { timeout: HTTP_TIMEOUT_MS }
      );
    }
  }
  // whatsapp: menyusul — cukup tambah entri {configField:'whatsappNumber', send: via penyedia}.
};

function listChannels() {
  return Object.values(CHANNELS).map((c) => ({ id: c.id, label: c.label, available: c.available() }));
}

function getMediaUrl(filename, req = null) {
  const encodedFilename = encodeURIComponent(filename);
  const configuredBase = process.env.PUBLIC_BASE_URL || process.env.API_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  const baseUrl = configuredBase || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:5000');
  return `${baseUrl.replace(/\/$/, '')}/uploads/notifications/${encodedFilename}`;
}

async function getConfig(userId) {
  return prisma.notificationConfig.findUnique({ where: { userId } });
}

/**
 * Kirim satu pesan ke satu pengguna lewat kanal-kanal yang diminta. Tiap kanal dicoba
 * mandiri: kegagalan satu kanal tidak membatalkan yang lain, dan setiap upaya (berhasil
 * atau gagal) selalu tercatat di NotificationLog.
 *
 * @returns {Array<{channel, status, error}>}
 */
async function sendToUser({ user, channels, subject, message, fileUrl, actor }) {
  const config = await getConfig(user.id);
  const requested = channels && channels.length ? channels : Object.keys(CHANNELS);
  const results = [];

  for (const channelId of requested) {
    const channel = CHANNELS[channelId];
    let status = 'FAILED';
    let error = null;

    if (!channel) {
      error = `Kanal tidak dikenal: ${channelId}`;
    } else if (!config || !config.isActive) {
      error = 'Notifikasi untuk pengguna ini nonaktif atau belum dikonfigurasi.';
    } else if (!channel.isConfigured(config)) {
      error = `Tujuan ${channel.label} belum diisi untuk pengguna ini.`;
    } else if (!channel.available()) {
      error = `Kanal ${channel.label} belum siap di server.`;
    } else {
      try {
        await channel.send(config[channel.configField], { subject, message, fileUrl });
        status = 'SENT';
      } catch (err) {
        error = err.response?.data?.description || err.response?.data?.message || err.message;
      }
    }

    // Catat setiap upaya. Kegagalan menulis log tidak boleh menggagalkan pengiriman.
    try {
      await prisma.notificationLog.create({
        data: {
          userId: user.id,
          recipientName: user.name || user.email,
          channel: channelId,
          subject: subject || null,
          message,
          status,
          error,
          actorId: actor?.id || null,
          actorName: actor?.name || null
        }
      });
    } catch (logErr) {
      console.error('[notificationService] gagal menulis log:', logErr.message);
    }

    results.push({ channel: channelId, status, error });
  }

  return results;
}

module.exports = { CHANNELS, listChannels, getConfig, sendToUser, getMediaUrl };
