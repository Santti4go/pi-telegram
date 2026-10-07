import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const assistant = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real extension: preview flushes are serialized, truncated and idempotent', { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-preview-'));
  const oldHome = process.env.HOME, oldFetch = globalThis.fetch;
  const state = { renames: [] };
  globalThis.__telegramExtensionTest = state;
  const hooks = new Map(), commands = new Map(), tools = new Map(), requests = [];
  const ctx = {
    cwd: '/project', isIdle: () => true,
    sessionManager: { getSessionFile: () => '/alpha.jsonl', getSessionId: () => 'alpha' },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_c, text) => text } },
  };
  let handleRequest = async () => Response.json({ ok: true, result: { message_id: 99 } });
  try {
    process.env.HOME = home;
    await mkdir(join(home, '.pi/agent'), { recursive: true });
    await writeFile(join(home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: '1:test', forumChatId: -100, allowedUserId: 7 }));
    globalThis.fetch = async (url, options) => {
      const request = { method: String(url).split('/').pop(), body: options.body instanceof FormData ? options.body : JSON.parse(options.body) };
      requests.push(request);
      return handleRequest(request);
    };
    const client = fileURLToPath(new URL('./forum-client.mjs', import.meta.url));
    const stub = fileURLToPath(new URL('./test/forum-client-stub.ts', import.meta.url));
    const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false, alias: { [client]: stub, './forum-client.mjs': stub } });
    const extension = await jiti.import('./index.ts');
    extension.default({
      on: (event, fn) => hooks.set(event, fn), registerTool: tool => tools.set(tool.name, tool),
      registerCommand: (name, def) => commands.set(name, def.handler),
      getSessionName: () => 'test', sendUserMessage() {},
    });
    await hooks.get('session_start')({}, ctx);
    await commands.get('telegram-connect')('', ctx);
    const begin = async () => {
      await state.onUpdate({ message: { message_id: 1, chat: { id: -100, type: 'supergroup' }, message_thread_id: 42, from: { id: 7 }, text: 'test' } });
      await hooks.get('agent_start')({}, ctx);
    };
    const update = text => hooks.get('message_update')({ message: assistant(text) }, ctx);
    const end = text => hooks.get('agent_end')({ messages: [assistant(text)] }, ctx);
    const edits = () => requests.filter(r => r.method === 'editMessageText');
    const sends = () => requests.filter(r => r.method === 'sendMessage');

    // Timer flush is still waiting for Telegram when final delivery starts.
    let release, started;
    const sending = new Promise(resolve => { started = resolve; });
    handleRequest = request => {
      if (request.method === 'sendMessage') {
        started();
        return new Promise(resolve => { release = () => resolve(Response.json({ ok: true, result: { message_id: 99 } })); });
      }
      return Response.json({ ok: true, result: {} });
    };
    await begin(); await update('same text'); await sending;
    const final = end('same text');
    await wait(20);
    assert.equal(sends().length, 1, 'final flush must wait for the existing send');
    release(); await final;
    assert.equal(sends().length, 1);
    assert.equal(edits().length, 0);

    // Compare transmitted text, not the untruncated pending text.
    requests.length = 0;
    handleRequest = async () => Response.json({ ok: true, result: { message_id: 99 } });
    await begin(); await update('a'.repeat(5000)); await wait(850);
    await update('a'.repeat(5000) + 'more'); await wait(850);
    assert.equal(sends().length, 1);
    assert.equal(sends()[0].body.text.length, 4096);
    assert.equal(edits().length, 0);
    await end('a'.repeat(5000) + 'more');

    // Telegram may normalize text or already have the edit: preserve attachments.
    requests.length = 0;
    await begin(); await update('first'); await wait(850);
    handleRequest = async request => request.method === 'editMessageText'
      ? Response.json({ ok: false, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' })
      : Response.json({ ok: true, result: { message_id: 99 } });
    const attachment = join(home, 'result.txt'); await writeFile(attachment, 'result');
    await tools.get('telegram_attach').execute('attach', { paths: [attachment] });
    await end('second');
    assert.equal(edits().length, 1);
    assert.equal(requests.filter(r => r.method === 'sendDocument').length, 1);
    assert.equal(edits()[0].body.chat_id, -100);
    assert.equal(edits()[0].body.message_id, 99);
    assert.equal(requests.find(r => r.method === 'sendDocument').body.get('message_thread_id'), '42');

    // Other Telegram errors must remain visible, not be treated as success.
    requests.length = 0;
    handleRequest = async () => Response.json({ ok: true, result: { message_id: 99 } });
    await begin(); await update('first'); await wait(850);
    handleRequest = async request => request.method === 'editMessageText'
      ? Response.json({ ok: false, description: 'Bad Request: message to edit not found' })
      : Response.json({ ok: true, result: { message_id: 99 } });
    await assert.rejects(end('second'), /message to edit not found/);
  } finally {
    await hooks.get('session_shutdown')?.({}, ctx);
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    globalThis.fetch = oldFetch;
    delete globalThis.__telegramExtensionTest;
    await rm(home, { recursive: true, force: true });
  }
});
