import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { parseTelegramCommand, findSessionCommand } from './commands.mjs';

test('command parsing preserves arguments and handles bot addressing', () => {
  assert.deepEqual(parseTelegramCommand('/custom-name@MyBot Mixed Case\narguments', 'mybot'),
    { name: 'custom-name', args: 'Mixed Case\narguments', text: '/custom-name Mixed Case\narguments' });
  assert.deepEqual(parseTelegramCommand('/model@OtherBot test', 'mybot'), { ignored: true });
  assert.equal(parseTelegramCommand('please use /model', 'mybot'), undefined);
  const commands = [];
  const pi = { getCommands: () => commands };
  assert.equal(findSessionCommand(pi, 'dynamic'), undefined);
  commands.push({ name: 'dynamic', source: 'extension' });
  assert.equal(findSessionCommand(pi, 'dynamic'), commands[0]);
});

test('real extension: model switching and unrestricted discovered commands are topic/user scoped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-commands-'));
  const oldHome = process.env.HOME;
  const oldFetch = globalThis.fetch;
  const oldReloadMarker = process.env.PI_TELEGRAM_PENDING_RELOAD;
  delete process.env.PI_TELEGRAM_PENDING_RELOAD;
  const state = { renames: [] };
  globalThis.__telegramExtensionTest = state;
  const hooks = new Map(), commands = new Map(), prompts = [], requests = [], switches = [];
  let busy = false, authenticated = true;
  let thinking = 'medium', thinkingError = false;
  const thinkingChanges = [];
  const available = [{ provider: 'test', id: 'first' }, { provider: 'test', id: 'nested/second' }];
  const discovered = [{ name: 'arbitrary', source: 'extension' }, { name: 'explain', source: 'prompt' }];
  const ctx = {
    cwd: '/project', isIdle: () => !busy,
    model: available[0],
    modelRegistry: { refresh: async () => {}, getAvailable: () => available, isUsingOAuth: () => false },
    getContextUsage: () => ({ contextWindow: 10000, percent: 10 }),
    sessionManager: {
      getSessionFile: () => '/alpha.jsonl', getSessionId: () => 'alpha',
      getEntries: () => [{ type: 'message', message: { role: 'user' } },
        { type: 'message', message: { role: 'assistant', usage: {
          input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 },
        } } }],
    },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_c, text) => text } },
  };
  let cleanupContext = ctx;
  try {
    process.env.HOME = home;
    await mkdir(join(home, '.pi/agent'), { recursive: true });
    await writeFile(join(home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: '1:test', botUsername: 'mybot', forumChatId: -100, allowedUserId: 7 }));
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      return Response.json({ ok: true, result: { message_id: 99 } });
    };
    const client = fileURLToPath(new URL('./forum-client.mjs', import.meta.url));
    const stub = fileURLToPath(new URL('./test/forum-client-stub.ts', import.meta.url));
    const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false, alias: { [client]: stub, './forum-client.mjs': stub } });
    const extension = await jiti.import('./index.ts');
    const api = {
      on: (event, fn) => hooks.set(event, fn), registerTool() {},
      registerCommand: (name, def) => commands.set(name, def.handler),
      getSessionName: () => 'test', getCommands: () => discovered,
      sendUserMessage: (content, options) => prompts.push({ content, options }),
      setModel: async model => { switches.push(model); if (authenticated) ctx.model = model; return authenticated; },
      getThinkingLevel: () => thinking,
      setThinkingLevel: level => {
        if (thinkingError) throw new Error('thinking unavailable');
        thinkingChanges.push(level);
        thinking = level === 'max' ? 'high' : level;
      },
    };
    extension.default(api);
    await hooks.get('session_start')({}, ctx);
    await commands.get('telegram-connect')('', ctx);
    const base = { message_id: 1, chat: { id: -100, type: 'supergroup' }, message_thread_id: 42, from: { id: 7 } };
    const send = (text, patch = {}) => state.onUpdate({ message: { ...base, text, ...patch } });
    await send('/session');
    assert.match(requests.at(-1).text, /Session: test/);
    assert.match(requests.at(-1).text, /ID: alpha/);
    assert.match(requests.at(-1).text, /File: \/alpha.jsonl/);
    assert.match(requests.at(-1).text, /Messages: 2/);
    assert.match(requests.at(-1).text, /Thinking: medium/);
    assert.match(requests.at(-1).text, /Cost: \$0\.001/);
    assert.equal(requests.at(-1).message_thread_id, 42);
    await send('/thinking');
    assert.match(requests.at(-1).text, /Current thinking level: medium/);
    assert.equal(requests.at(-1).message_thread_id, 42);
    await send('/thinking@MyBot HIGH');
    assert.equal(thinking, 'high');
    assert.match(requests.at(-1).text, /Thinking level set to high/);
    await send('/thinking max');
    assert.match(requests.at(-1).text, /Requested max; thinking level set to high/);
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      await send(`/thinking ${level}`);
      assert.equal(thinking, level);
    }
    const changes = thinkingChanges.length;
    await send('/thinking nonsense');
    assert.match(requests.at(-1).text, /Invalid thinking level/);
    await send('/thinking high extra');
    assert.match(requests.at(-1).text, /Invalid thinking level/);
    busy = true;
    await send('/thinking high');
    assert.match(requests.at(-1).text, /Cannot change thinking/);
    await send('/thinking');
    assert.match(requests.at(-1).text, /Current thinking level/);
    busy = false;
    const beforeIgnored = requests.length;
    await send('/thinking high', { from: { id: 8 } });
    await send('/thinking high', { message_thread_id: 43 });
    await send('/thinking high', { chat: { id: -200, type: 'supergroup' } });
    await send('/thinking@OtherBot high');
    assert.equal(requests.length, beforeIgnored);
    assert.equal(thinkingChanges.length, changes);
    thinkingError = true;
    await send('/thinking high');
    assert.match(requests.at(-1).text, /Thinking command failed: thinking unavailable/);
    thinkingError = false;
    assert.equal(prompts.length, 0, 'thinking commands never reach the AI');
    await send('/models');
    assert.match(requests.at(-1).text, /2\. test\/nested\/second/);
    assert.equal(requests.at(-1).message_thread_id, 42);
    await send('/model@MyBot 2');
    assert.equal(switches.at(-1), available[1]);
    assert.match(requests.at(-1).text, /Model switched/);
    await send('/model');
    assert.match(requests.at(-1).text, /Current model: test\/nested\/second/);
    await send('/model missing');
    assert.match(requests.at(-1).text, /Unknown or unavailable/);
    busy = true; await send('/model 1'); busy = false;
    assert.equal(switches.length, 1);
    authenticated = false; await send('/model test/first');
    assert.match(requests.at(-1).text, /authentication/);
    const count = requests.length;
    await send('/model 1', { from: { id: 8 } });
    await send('/model 1', { message_thread_id: 43 });
    await send('/model 1', { chat: { id: -200, type: 'supergroup' } });
    await send('/model@OtherBot 1');
    assert.equal(requests.length, count);
    await send('/does-not-exist');
    assert.match(requests.at(-1).text, /Not sent to the AI/);
    assert.equal(prompts.length, 0);
    await send('/arbitrary@mybot Mixed Case');
    assert.deepEqual(prompts.at(-1), { content: '/arbitrary Mixed Case', options: { expandPromptTemplates: true } });
    discovered.push({ name: 'new-command', source: 'extension' });
    await send('/new-command');
    assert.equal(prompts.at(-1).content, '/new-command');
    busy = true; await send('/arbitrary'); busy = false;
    assert.equal(prompts.length, 2);
    await send('/explain arguments');
    assert.deepEqual(prompts.at(-1).content, [{ type: 'text', text: '/explain arguments' }]);
    assert.equal(prompts.at(-1).options.expandPromptTemplates, true);
    await hooks.get('agent_start')({}, ctx);
    await hooks.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Template reply' }] }] }, ctx);
    assert.equal(requests.at(-1).text, 'Template reply');
    assert.equal(requests.at(-1).message_thread_id, 42);

    // Reload dispatch obtains a command context; no AI turn is queued.
    const beforeReload = prompts.length;
    busy = true; await send('/reload'); busy = false;
    assert.match(requests.at(-1).text, /Cannot reload while Pi is busy/);
    await send('/reload extra');
    assert.match(requests.at(-1).text, /Usage: \/reload/);
    await send('/reload', { from: { id: 8 } });
    await send('/reload', { message_thread_id: 43 });
    assert.equal(prompts.length, beforeReload);
    await send('/reload@mybot');
    assert.deepEqual(prompts.at(-1), { content: '/telegram-reload', options: { expandPromptTemplates: true } });
    ctx.reload = async () => { throw new Error('test reload failure'); };
    await commands.get('telegram-reload')('', ctx);
    assert.match(requests.at(-1).text, /Reload failed: test reload failure/);
    assert.equal(requests.at(-1).message_thread_id, 42);
    assert.equal(process.env.PI_TELEGRAM_PENDING_RELOAD, undefined);
    ctx.reload = async () => {}; // A host may swallow reload errors.
    await send('/reload');
    await commands.get('telegram-reload')('', ctx);
    assert.match(requests.at(-1).text, /did not complete extension replacement/);
    assert.equal(process.env.PI_TELEGRAM_PENDING_RELOAD, undefined);

    // Simulate replacement: old ctx becomes unusable, fresh session_start reconnects.
    const freshCtx = { ...ctx };
    ctx.reload = async () => {
      assert.match(process.env.PI_TELEGRAM_PENDING_RELOAD, /alpha/);
      await hooks.get('session_shutdown')({}, ctx);
      Object.defineProperty(ctx, 'ui', { get() { throw new Error('stale UI'); } });
      ctx.isIdle = () => { throw new Error('stale context'); };
      extension.default(api);
      cleanupContext = freshCtx;
      await hooks.get('session_start')({}, freshCtx);
    };
    await send('/reload');
    await commands.get('telegram-reload')('', ctx);
    assert.equal(process.env.PI_TELEGRAM_PENDING_RELOAD, undefined);
    assert.equal(requests.at(-1).text, 'Pi reloaded. Telegram reconnected.');
    assert.equal(requests.at(-1).message_thread_id, 42);
    await send('/thinking');
    assert.match(requests.at(-1).text, /Current thinking level/);

    // The real host begins extension handlers synchronously. Disconnect clears
    // the binding before sendUserMessage returns, so capture the reply topic.
    discovered.push({ name: 'telegram-disconnect', source: 'extension' });
    let commandExecution;
    api.sendUserMessage = (content, options) => {
      prompts.push({ content, options });
      if (content === '/telegram-disconnect') {
        commandExecution = commands.get('telegram-disconnect')('', freshCtx);
      }
    };
    await send('/telegram-disconnect');
    await commandExecution;
    assert.match(requests.at(-1).text, /Dispatched \/telegram-disconnect/);
    assert.equal(requests.at(-1).chat_id, -100);
    assert.equal(requests.at(-1).message_thread_id, 42,
      'command acknowledgement must stay in the originating topic after disconnect');
  } finally {
    await hooks.get('session_shutdown')?.({}, cleanupContext);
    if (oldReloadMarker === undefined) delete process.env.PI_TELEGRAM_PENDING_RELOAD;
    else process.env.PI_TELEGRAM_PENDING_RELOAD = oldReloadMarker;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    globalThis.fetch = oldFetch;
    delete globalThis.__telegramExtensionTest;
    await rm(home, { recursive: true, force: true });
  }
});
