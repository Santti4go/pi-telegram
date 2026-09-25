// Started under flock by forum-client. One dispatcher for the configured bot.
import { createServer } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, saveJson, provision, accepts, routeKey, renameTopic } from './forum.mjs';

const dir = process.argv[2];
const socketPath = join(dir, 'dispatcher.sock');
const configPath = join(dir, '..', 'telegram.json');
const mappingPath = join(dir, '..', 'telegram-threads.json');
const cursorPath = join(dir, 'cursor.json');
const clients = new Map();
const sockets = new Set();
let serial = Promise.resolve();
let polling = false;
let currentConfig;
let idleSince = Date.now();

async function api(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${currentConfig.botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || `Telegram ${method} failed`);
  return result.result;
}
function send(socket, data) {
  if (!socket.destroyed) {
    if (socket.writableLength > 1024 * 1024) return socket.destroy();
    socket.write(JSON.stringify(data) + '\n');
  }
}
async function register(socket, request) {
  if (socket.binding) throw new Error('Already registered');
  const config = await readJson(configPath, {});
  if (!config.botToken || !Number.isSafeInteger(config.forumChatId) || config.allowedUserId === undefined)
    throw new Error('Configure botToken, numeric forumChatId and allowedUserId in telegram.json.');
  if (currentConfig && (config.botToken !== currentConfig.botToken ||
      config.forumChatId !== currentConfig.forumChatId || config.allowedUserId !== currentConfig.allowedUserId))
    throw new Error('Configuration changed. Disconnect all forum sessions, wait 5 seconds, then reconnect.');
  currentConfig = config;
  for (const client of clients.values()) {
    if (client.binding.sessionFile === request.sessionFile && client.binding.sessionId === request.sessionId)
      throw new Error('This session topic is already connected in another Pi process.');
  }
  const store = await readJson(mappingPath, { threads: [] });
  const binding = await provision(api, config, request, store);
  await saveJson(mappingPath, store);
  if (socket.destroyed) return;
  const key = routeKey(binding.chatId, binding.messageThreadId);
  if (clients.has(key)) throw new Error('Topic already connected.');
  socket.binding = binding;
  clients.set(key, socket);
  send(socket, { type: 'ready', binding });
  if (!polling) { polling = true; void poll(); }
}
async function renameSessionTopic(socket, request) {
  if (socket.destroyed) return;
  if (!socket.binding || typeof request.name !== 'string') throw new Error('Invalid topic rename request.');
  const store = await readJson(mappingPath, { threads: [] });
  const binding = store.threads.find(t => t.botId === socket.binding.botId &&
    t.chatId === socket.binding.chatId && t.messageThreadId === socket.binding.messageThreadId &&
    t.sessionId === socket.binding.sessionId && t.sessionFile === socket.binding.sessionFile);
  if (!binding) throw new Error('Topic mapping is missing. Reconnect this session.');
  await renameTopic(api, binding, request.name, request.force === true);
  await saveJson(mappingPath, store);
  socket.binding = binding;
  send(socket, { type: 'renamed', binding });
}
async function poll() {
  let cursor = await readJson(cursorPath, {});
  const botTokenId = currentConfig.botToken.split(':')[0];
  if (cursor.botTokenId !== botTokenId) cursor = { botTokenId };
  let initialized = false;
  while (true) {
    try {
      if (!initialized) {
        await api('deleteWebhook', { drop_pending_updates: false });
        if (cursor.offset === undefined) {
          const latest = await api('getUpdates', { offset: -1, limit: 1, timeout: 0 });
          cursor.offset = latest.length ? latest[0].update_id + 1 : 0;
          await saveJson(cursorPath, cursor);
        }
        initialized = true;
      }
      const updates = await api('getUpdates', { offset: cursor.offset, timeout: 30, allowed_updates: ['message', 'edited_message'] });
      for (const update of updates) {
        const message = update.message || update.edited_message;
        const client = message && clients.get(routeKey(message.chat.id, message.message_thread_id));
        if (client && accepts(message, client.binding, currentConfig.allowedUserId)) send(client, { type: 'update', update });
        // Live delivery, not durable offline delivery. Unbound topics are intentionally ignored.
        cursor.offset = update.update_id + 1;
        await saveJson(cursorPath, cursor);
      }
    } catch (e) {
      for (const client of clients.values()) send(client, { type: 'error', error: e.message });
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
const server = createServer(socket => {
  sockets.add(socket);
  socket.setEncoding('utf8');
  socket.on('error', () => socket.destroy());
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 65536) return socket.destroy();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      serial = serial.then(async () => {
        try {
          const request = JSON.parse(line);
          if (request.type === 'rename') await renameSessionTopic(socket, request);
          else await register(socket, request);
        } catch (e) {
          if (socket.binding) send(socket, { type: 'error', error: `Topic update failed: ${e.message}` });
          else { send(socket, { type: 'rejected', error: e.message }); socket.end(); }
        }
      });
    }
  });
  socket.on('close', () => {
    sockets.delete(socket);
    if (socket.binding) {
      const key = routeKey(socket.binding.chatId, socket.binding.messageThreadId);
      if (clients.get(key) === socket) clients.delete(key);
    }
    idleSince = Date.now();
  });
});
server.listen(socketPath, async () => { await chmod(socketPath, 0o600); });
server.on('error', () => process.exit(1));
setInterval(() => {
  if (!sockets.size && Date.now() - idleSince > 4000) process.exit(0);
}, 1000);
