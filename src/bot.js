'use strict';

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const config = require('./config');
const logger = require('./logger');

if (!config.telegram.enabled) {
  logger.warn('TELEGRAM_BOT_TOKEN not set; bot will not start. Exiting.');
  process.exit(0);
}

const bot = new Telegraf(config.telegram.token);
const API = config.telegram.apiUrl;

// Map a Telegram user to an identity: a configured tenant (or the server
// default) and a per-user id `tg_<telegram-user-id>`, so each Telegram user's
// receipts are isolated within the tenant.
function identityHeaders(telegramUserId) {
  const headers = {};
  if (config.telegram.tenantId) headers['X-Tenant-Id'] = config.telegram.tenantId;
  if (telegramUserId != null) headers['X-User-Id'] = `tg_${telegramUserId}`;
  return headers;
}

async function uploadToApi(fileLink, filename, mimeType, telegramUserId) {
  const imgRes = await fetch(fileLink);
  if (!imgRes.ok) throw new Error(`could not download telegram file (${imgRes.status})`);
  const buf = Buffer.from(await imgRes.arrayBuffer());

  const form = new FormData();
  form.append('source', 'telegram');
  form.append('receipt', new Blob([buf], { type: mimeType || 'image/jpeg' }), filename || 'receipt.jpg');

  const res = await fetch(`${API}/api/receipts`, {
    method: 'POST',
    body: form,
    headers: identityHeaders(telegramUserId),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `API responded ${res.status}`);
  return data; // { id, status, statusUrl, viewUrl }
}

bot.start((ctx) =>
  ctx.reply(
    'Send me a photo of a grocery receipt and I will extract the items, look up product images, and send you a link to the full breakdown.'
  )
);
bot.help((ctx) => ctx.reply('Just send a receipt photo (as a photo or as an image file).'));

bot.on(message('photo'), async (ctx) => {
  try {
    await ctx.reply('Got it — processing your receipt…');
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const link = await ctx.telegram.getFileLink(largest.file_id);
    const data = await uploadToApi(link.href, `${largest.file_unique_id}.jpg`, 'image/jpeg', ctx.from && ctx.from.id);
    await ctx.reply(
      `Queued! View the breakdown here once it finishes:\n${data.viewUrl}\n\n(it updates live as items are enriched)`
    );
  } catch (err) {
    logger.error({ err: err.message }, 'telegram photo handler failed');
    await ctx.reply(`Sorry, something went wrong: ${err.message}`);
  }
});

bot.on(message('document'), async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type || !doc.mime_type.startsWith('image/')) {
    return ctx.reply('Please send an image of the receipt (jpg/png).');
  }
  try {
    await ctx.reply('Got it — processing your receipt…');
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const data = await uploadToApi(link.href, doc.file_name || 'receipt.jpg', doc.mime_type, ctx.from && ctx.from.id);
    await ctx.reply(`Queued! View the breakdown here:\n${data.viewUrl}`);
  } catch (err) {
    logger.error({ err: err.message }, 'telegram document handler failed');
    await ctx.reply(`Sorry, something went wrong: ${err.message}`);
  }
});

bot.launch().then(() => logger.info({ api: API }, 'telegram bot launched'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
