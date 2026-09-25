// Bounded integration probe: real dispatcher + real forum clients, local Telegram API.
// Run: node --max-old-space-size=192 audit/multi-topic-probe.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectForum } from '../forum-client.mjs';
import { saveJson, readJson } from '../forum.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timeout: ${label}`);
}
const home = await mkdtemp(join(tmpdir(), 'telegram-multi-audit-'));
const previousHome = process.env.HOME;
const dir = join(home, '.pi/agent/telegram-runtime');
const topicCount = Number(process.argv[2] ?? 8);
assert.ok(Number.isInteger(topicCount) && topicCount >= 1 && topicCount <= 8, 'Use 1–8 topics');
const messageCount = topicCount * 50;
const clients = [], errors = [], seen = Array.from({ length: topicCount }, () => []);
let updates = [], topic = 40, polling = 0, maxPolling = 0, started = 0, completed = 0, closed = 0;
let release;
const gate = new Promise(resolve => { release = resolve; });
let child, childExit;
const http = createServer(async (req, res) => {
  try {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    let result = true;
    switch (req.url) {
      case '/getMe': result = { id: 1 }; break;
      case '/getChat': result = { type: 'supergroup', is_forum: true }; break;
      case '/getChatMember': result = { status: 'administrator', can_manage_topics: true }; break;
      case '/createForumTopic': result = { message_thread_id: ++topic }; break;
      case '/getUpdates':
        polling++; maxPolling = Math.max(maxPolling, polling);
        await delay(40);
        result = updates.filter(update => update.update_id >= body.offset).slice(0, 100);
        polling--; break;
    }
    res.end(JSON.stringify({ ok: true, result }));
  } catch (error) { errors.push(error.message); res.destroy(); }
});
async function sample(label) {
  if (process.env.AUDIT_EXPECT_LIMITS === '1') {
    const group = (await readFile('/proc/self/cgroup', 'utf8')).trim().split('0::')[1];
    const base = join('/sys/fs/cgroup', group);
    const values = {};
    for (const name of ['memory.max', 'memory.swap.max', 'memory.peak', 'memory.events', 'cpu.max', 'pids.max']) {
      values[name] = (await readFile(join(base, name), 'utf8')).trim();
    }
    assert.equal(values['memory.max'], '268435456');
    assert.equal(values['memory.swap.max'], '0');
    console.log(JSON.stringify({ cgroup: values }));
  }
  const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
  console.log(JSON.stringify({ label, dispatcherRSS: status.match(/^VmRSS:\s+(.+)$/m)?.[1],
    harnessRSSMiB: Math.round(process.memoryUsage().rss / 1048576), started, completed }));
}
try {
  process.env.HOME = home;
  await mkdir(dir, { recursive: true });
  await saveJson(join(dir, '../telegram.json'), { botToken: '1:test', forumChatId: -100, allowedUserId: 7 });
  await saveJson(join(dir, 'cursor.json'), { botTokenId: '1', offset: 1 });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['--max-old-space-size=128', '--import',
    fileURLToPath(new URL('../test/mock-telegram.mjs', import.meta.url)),
    fileURLToPath(new URL('../dispatcher.mjs', import.meta.url)), dir], {
    env: { ...process.env, TEST_TELEGRAM_URL: `http://127.0.0.1:${http.address().port}` }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  childExit = once(child, 'exit');
  child.stderr.on('data', chunk => errors.push(String(chunk)));
  // Prestart only the mock-backed dispatcher; never let connectForum spawn a real-network one.
  await waitFor(async () => stat(join(dir, 'dispatcher.sock')).then(() => true, () => false), 'socket');
  for (let i = 0; i < topicCount; i++) {
    clients.push(await connectForum({ sessionId: `audit-${i}`, sessionFile: `/audit-${i}.jsonl`, name: `audit-${i}` }, {
      async onUpdate(update) {
        started++;
        assert.equal(update.message.message_thread_id, clients[i].binding.messageThreadId);
        await gate;
        seen[i].push(update.update_id);
        completed++;
      },
      onError: error => errors.push(error), onClose: () => { closed++; },
    }));
  }
  await sample(`${topicCount} connected, no traffic`);
  updates = Array.from({ length: messageCount }, (_, i) => ({ update_id: i + 1, message: {
    message_id: i + 1, chat: { id: -100, type: 'supergroup' }, from: { id: 7 },
    message_thread_id: clients[i % topicCount].binding.messageThreadId, text: `${i}:` + 'x'.repeat(4000),
  } }));
  await waitFor(async () => (await readJson(join(dir, 'cursor.json'), {})).offset === messageCount + 1, 'cursor confirms all messages');
  await waitFor(() => started === topicCount, 'one blocked handler per client');
  await delay(150);
  assert.equal(completed, 0);
  assert.equal(maxPolling, 1);
  await sample(`${messageCount} forwarded/confirmed, ${topicCount} blocked handlers, 0 completed`);
  // Keep connections open: release demonstrates retained backlog, not dropped delivery.
  release();
  await waitFor(() => completed === messageCount, 'drain retained backlog');
  assert.ok(seen.every(ids => ids.length === 50 && new Set(ids).size === 50));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`CONFIRMED: all ${topicCount} topics receive exactly their 50 messages; one shared getUpdates poll.`);
  console.log(`CONFIRMED: stalled consumers do not stop dispatcher cursor advancement; ${messageCount - topicCount} handlers waited behind ${topicCount} blocked handlers.`);
  for (const client of clients) client.close();
  await waitFor(() => closed === topicCount, 'client close');
  await waitFor(() => child.exitCode !== null, 'dispatcher idle exit', 7000);
  assert.equal(child.exitCode, 0);
  console.log('CONFIRMED: dispatcher exits normally after all clients close.');
} finally {
  release();
  for (const client of clients) client.close();
  if (child && child.exitCode === null) child.kill();
  if (childExit) await childExit;
  http.closeAllConnections();
  if (http.listening) await new Promise(resolve => http.close(resolve));
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
}
