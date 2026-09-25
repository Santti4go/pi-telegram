import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { saveJson, readJson } from './forum.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));

test('dispatcher routes two live sessions independently and rejects duplicate ownership', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-forum-'));
  const runtime = join(dir, 'runtime'); await mkdir(runtime);
  await saveJson(join(dir, 'telegram.json'), { botToken: '1:test', forumChatId: -100, allowedUserId: 7 });
  let nextTopic = 40; let updates = []; let polling = 0; let maxPolling = 0;
  const renames = [];
  const http = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); let result = true;
    switch (req.url) {
      case '/editForumTopic':
        if (body.name.endsWith('Denied')) {
          res.writeHead(200); res.end(JSON.stringify({ ok: false, description: 'Forbidden' })); return;
        }
        renames.push(body); break;
      case '/getMe': result = { id: 1 }; break;
      case '/getChat': result = { type: 'supergroup', is_forum: true }; break;
      case '/getChatMember': result = { status: 'administrator', can_manage_topics: true }; break;
      case '/createForumTopic': result = { message_thread_id: ++nextTopic }; break;
      case '/getUpdates':
        polling++; maxPolling = Math.max(maxPolling, polling);
        await delay(body.timeout ? 40 : 0);
        result = updates.filter(u => u.update_id >= body.offset);
        polling--; break;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./test/mock-telegram.mjs', import.meta.url)),
    fileURLToPath(new URL('./dispatcher.mjs', import.meta.url)), runtime],
    { env: { ...process.env, TEST_TELEGRAM_URL: `http://127.0.0.1:${http.address().port}` }, stdio: 'ignore' });
  const clients = [];
  async function client(id) {
    let socket;
    for (let i = 0; i < 50; i++) {
      try {
        socket = await new Promise((resolve, reject) => {
          const s = connect(join(runtime, 'dispatcher.sock'));
          s.once('error', e => { s.destroy(); reject(e); }); s.once('connect', () => resolve(s));
        }); break;
      } catch { await delay(30); }
    }
    assert.ok(socket);
    clients.push(socket);
    const messages = []; let buffer = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
      }
    });
    socket.write(JSON.stringify({ sessionFile: `/${id}`, sessionId: id, name: id }) + '\n');
    for (let i = 0; i < 100 && !messages.length; i++) await delay(20);
    return { socket, messages };
  }
  try {
    const a = await client('alpha'); const b = await client('beta');
    assert.equal(a.messages[0].type, 'ready'); assert.equal(b.messages[0].type, 'ready');
    const duplicate = await client('alpha'); assert.equal(duplicate.messages[0].type, 'rejected');
    updates = [
      [1, 41, 7, 'a'], [2, 42, 7, 'b'], [3, 41, 8, 'unauthorized'], [4, 1, 7, 'General'],
    ].map(([update_id, thread, user, text]) => ({ update_id, message: { message_id: update_id, chat: { id: -100 }, message_thread_id: thread, from: { id: user }, text } }));
    await delay(250);
    assert.deepEqual(a.messages.filter(m => m.type === 'update').map(m => m.update.message.text), ['a']);
    assert.deepEqual(b.messages.filter(m => m.type === 'update').map(m => m.update.message.text), ['b']);
    a.socket.write(JSON.stringify({ type: 'rename', name: 'Backend', messageThreadId: 42 }) + '\n');
    for (let i = 0; i < 100 && !a.messages.some(m => m.type === 'renamed'); i++) await delay(20);
    assert.deepEqual(renames, [{ chat_id: -100, message_thread_id: 41, name: 'π session — Backend' }]);
    const mapping = await readJson(join(dir, 'telegram-threads.json'));
    assert.equal(mapping.threads.find(t => t.sessionId === 'alpha').topicName, 'π session — Backend');
    assert.equal(mapping.threads.find(t => t.sessionId === 'beta').topicName, 'π session — beta');
    a.socket.write(JSON.stringify({ type: 'rename', name: 'Denied' }) + '\n');
    for (let i = 0; i < 100 && !a.messages.some(m => m.type === 'error'); i++) await delay(20);
    assert.ok(a.messages.some(m => m.type === 'error'));
    assert.equal(a.socket.destroyed, false);
    a.socket.destroy(); await delay(100);
    const resumed = await client('alpha'); assert.equal(resumed.messages[0].binding.messageThreadId, 41);
    assert.equal(nextTopic, 42);
    assert.equal(resumed.messages[0].binding.topicName, 'π session — alpha');
    assert.equal(renames.at(-1).name, 'π session — alpha');
    assert.equal(maxPolling, 1);
  } finally {
    for (const socket of clients) socket.destroy();
    child.kill(); await new Promise(r => child.once('exit', r));
    http.closeAllConnections(); await new Promise(r => http.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
