import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

test('real extension: rename isolation, media downloads and topic-scoped replies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-inbound-rename-'));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network access forbidden in extension unit test'); };
  const state = { renames: [], prompts: [] };
  globalThis.__telegramExtensionTest = state;
  let name = 'old';
  const hooks = new Map(); const commands = new Map(); const tools = new Map();
  const ctx = {
    cwd: '/project', isIdle: () => true,
    sessionManager: { getSessionFile: () => '/alpha.jsonl', getSessionId: () => 'alpha' },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text } },
  };
  try {
    process.env.HOME = home;
    await mkdir(join(home, '.pi/agent'), { recursive: true });
    await writeFile(join(home, '.pi/agent/telegram.json'), JSON.stringify({ botToken: '1:test', forumChatId: -100, allowedUserId: 7 }));
    const client = fileURLToPath(new URL('./forum-client.mjs', import.meta.url));
    const stub = fileURLToPath(new URL('./test/forum-client-stub.ts', import.meta.url));
    const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false, alias: { [client]: stub, './forum-client.mjs': stub } });
    const extension = await jiti.import('./index.ts');
    extension.default({
      on(event, fn) { hooks.set(event, fn); }, registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(command, def) { commands.set(command, def.handler); },
      getSessionName: () => name,
      setSessionName(value) { name = value; void hooks.get('session_info_changed')({ name }, ctx); },
      sendUserMessage(value) { state.prompts.push(value); },
    });
    await hooks.get('session_start')({}, ctx);
    await commands.get('telegram-connect')('', ctx);
    assert.equal(typeof state.onUpdate, 'function');
    const message = { message_id: 1, chat: { id: -100, type: 'supergroup' }, message_thread_id: 42, from: { id: 7 }, forum_topic_edited: { name: 'Backend' } };
    await state.onUpdate({ update_id: 1, message });
    assert.equal(name, 'Backend');
    assert.deepEqual(state.renames, [{ name: 'Backend', force: true }]);
    assert.deepEqual(state.prompts, []);
    // Telegram sends a bot-authored service event after our normalization: ignore it.
    await state.onUpdate({ message: { ...message, from: { id: 1, is_bot: true }, forum_topic_edited: { name: 'π session — Backend' } } });
    for (const patch of [{ from: { id: 8 } }, { message_thread_id: 43 }, { chat: { id: -200 } }, { forum_topic_edited: { icon_custom_emoji_id: '123' } }]) {
      await state.onUpdate({ message: { ...message, ...patch } });
    }
    assert.equal(state.renames.length, 1);
    assert.equal(name, 'Backend');
    assert.deepEqual(state.prompts, []);
    await state.onUpdate({ message: { ...message, forum_topic_edited: { name: 'π session — claaro' } } });
    assert.equal(name, 'claaro');
    assert.equal(state.renames.length, 2);
    name = 'From Pi'; await hooks.get('session_info_changed')({ name }, ctx);
    assert.deepEqual(state.renames.at(-1), { name: 'From Pi', force: undefined });

    // Exercise the refactored media pipeline through the real extension, not helper copies.
    const requests = [];
    globalThis.fetch = async (url, options) => {
      const method = String(url).split('/').pop();
      if (String(url).includes('/file/bot')) return new Response('file contents');
      const body = options.body instanceof FormData ? options.body : JSON.parse(options.body);
      requests.push({ method, body });
      const result = method === 'getFile' ? { file_path: body.file_id } : { message_id: 99 };
      return Response.json({ ok: true, result });
    };
    await state.onUpdate({ message: {
      ...message, forum_topic_edited: undefined, caption: 'Files',
      photo: [{ file_id: 'small', file_size: 1 }, { file_id: 'large', file_size: 10 }],
      document: { file_id: 'document', file_name: 'picture.png', mime_type: 'image/png' },
      video: { file_id: 'video' },
      audio: { file_id: 'audio', file_name: 'music.wav', mime_type: 'audio/wav' },
      voice: { file_id: 'voice', mime_type: 'audio/ogg' },
      animation: { file_id: 'animation', mime_type: 'video/mp4' },
      sticker: { file_id: 'sticker' },
    } });
    assert.deepEqual(requests.filter(r => r.method === 'getFile').map(r => r.body.file_id),
      ['large', 'document', 'video', 'audio', 'voice', 'animation', 'sticker']);
    assert.equal(requests.filter(r => r.method === 'getFile').some(r => 'message_thread_id' in r.body), false);
    assert.equal(state.prompts.length, 1);
    const content = state.prompts[0];
    for (const fileName of ['photo-1.jpg', 'picture.png', 'video-1.mp4', 'music.wav', 'voice-1.ogg', 'animation-1.mp4', 'sticker-1.webp']) {
      assert.ok(content[0].text.includes(fileName), fileName);
    }
    assert.deepEqual(content.filter(c => c.type === 'image').map(c => c.mimeType), ['image/jpeg', 'image/png', 'image/webp']);

    // JSON sends and multipart uploads must retain their content types and topic routing.
    await hooks.get('agent_start')({}, ctx);
    const attachment = join(home, 'result.txt');
    await writeFile(attachment, 'result');
    await tools.get('telegram_attach').execute('attach', { paths: [attachment] });
    await hooks.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] }] }, ctx);
    const reply = requests.find(r => r.method === 'sendMessage');
    assert.deepEqual(reply.body, { chat_id: -100, text: 'Done', message_thread_id: 42 });
    const upload = requests.find(r => r.method === 'sendDocument');
    assert.ok(upload.body instanceof FormData);
    assert.equal(upload.body.get('chat_id'), '-100');
    assert.equal(upload.body.get('message_thread_id'), '42');
    assert.equal(await upload.body.get('document').text(), 'result');

    await state.onUpdate({ message: { ...message, forum_topic_edited: undefined, text: '/help' } });
    assert.ok(requests.at(-1).body.text.startsWith('Send me a message'));
    assert.equal(requests.at(-1).body.message_thread_id, 42);
  } finally {
    if (hooks.has('session_shutdown')) await hooks.get('session_shutdown')({}, ctx);
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    globalThis.fetch = originalFetch;
    delete globalThis.__telegramExtensionTest;
    await rm(home, { recursive: true, force: true });
  }
});
