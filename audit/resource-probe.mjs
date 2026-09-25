// Bounded, offline audit probe. Run from the repository: node audit/resource-probe.mjs
// Documents current risks; this is not a safety/regression test.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const home = await mkdtemp(join(tmpdir(), 'telegram-resource-audit-'));
const original = { home: process.env.HOME, fetch: globalThis.fetch, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
const hooks = new Map(), commands = new Map();
const state = { renames: [] };
let busy = false, tick, pending = [], status = '';
const ctx = {
  cwd: '/audit', isIdle: () => !busy,
  sessionManager: { getSessionFile: () => '/audit.jsonl', getSessionId: () => 'audit' },
  ui: { notify(text) { status = text; }, setStatus() {}, theme: { fg: (_, text) => text } },
};
try {
  process.env.HOME = home;
  globalThis.__telegramExtensionTest = state;
  await mkdir(join(home, '.pi/agent'), { recursive: true });
  await writeFile(join(home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: '1:test', forumChatId: -100, allowedUserId: 7 }));
  // No network, real timers, model requests, or large allocations.
  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    const request = { signal: options.signal, reject };
    pending.push(request);
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  globalThis.setInterval = fn => { tick = fn; return 1; };
  globalThis.clearInterval = () => { tick = undefined; };
  const client = fileURLToPath(new URL('../forum-client.mjs', import.meta.url));
  const stub = fileURLToPath(new URL('../test/forum-client-stub.ts', import.meta.url));
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false, alias: { [client]: stub, './forum-client.mjs': stub } });
  const extension = await jiti.import('../index.ts');
  extension.default({
    on: (name, fn) => hooks.set(name, fn), registerCommand: (name, def) => commands.set(name, def.handler),
    registerTool() {}, getSessionName: () => 'audit', sendUserMessage() {},
  });
  await hooks.get('session_start')({}, ctx);
  await commands.get('telegram-connect')('', ctx);
  const message = { message_id: 1, chat: { id: -100, type: 'supergroup' }, message_thread_id: 42, from: { id: 7 }, text: 'small offline probe' };
  await state.onUpdate({ message });
  for (let i = 0; i < 25; i++) tick();
  assert.equal(pending.length, 26);
  console.log('CONFIRMED: 26 concurrent typing requests after 25 simulated interval ticks with stalled fetch.');
  busy = true;
  for (let i = 0; i < 200; i++) await state.onUpdate({ message: { ...message, message_id: i + 2 } });
  await commands.get('telegram-status')('', ctx);
  assert.match(status, /queued telegram turns: 201/);
  console.log('CONFIRMED: 201 small turns accepted into the local queue without backpressure.');
  await hooks.get('session_shutdown')({}, ctx);
  assert.ok(pending.every(request => request.signal.aborted));
  await new Promise(resolve => setImmediate(resolve));
  console.log('CONFIRMED: existing shutdown change aborts all pending typing requests.');
} finally {
  await hooks.get('session_shutdown')?.({}, ctx);
  globalThis.fetch = original.fetch;
  globalThis.setInterval = original.setInterval;
  globalThis.clearInterval = original.clearInterval;
  if (original.home === undefined) delete process.env.HOME; else process.env.HOME = original.home;
  delete globalThis.__telegramExtensionTest;
  await rm(home, { recursive: true, force: true });
}
