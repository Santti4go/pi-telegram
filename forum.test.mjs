import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accepts, threadParams, provision, saveJson, readJson,
  renameTopic, topicNameFor, sessionNameFromTopic,
} from './forum.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = { forumChatId: -100, allowedUserId: 7 };
const session = { sessionFile: '/session.jsonl', sessionId: 'alpha', name: 'alpha' };
function mock(overrides = {}) {
  const calls = [];
  const api = async (method, body) => {
    calls.push({ method, body });
    if (overrides[method]) return overrides[method](body);
    return ({ getMe: { id: 1 }, getChat: { type: 'supergroup', is_forum: true },
      getChatMember: { status: 'administrator', can_manage_topics: true },
      createForumTopic: { message_thread_id: 42 }, sendMessage: { message_id: 10 } })[method];
  };
  return { api, calls };
}
test('provisions and reuses a persistent topic', async () => {
  const { api, calls } = mock(); const store = { threads: [] };
  const first = await provision(api, config, session, store);
  const second = await provision(api, config, session, store);
  assert.deepEqual(first, second);
  assert.equal(store.threads.length, 1);
  assert.equal(calls.filter(c => c.method === 'createForumTopic').length, 1);
  assert.equal(first.chatId, -100);
});
test('different sessions and chats get separate topics', async () => {
  const { api } = mock(); const store = { threads: [] };
  await provision(api, config, session, store);
  await provision(api, config, { ...session, sessionId: 'beta', sessionFile: '/beta' }, store);
  await provision(api, { ...config, forumChatId: -200 }, session, store);
  assert.equal(store.threads.length, 3);
});
test('deleted topic replaced; network and permission errors never create duplicates', async () => {
  const store = { threads: [] }; await provision(mock().api, config, session, store);
  for (const reason of ['network failed', 'Forbidden']) {
    const { api, calls } = mock({ sendMessage: () => { throw new Error(reason); } });
    await assert.rejects(provision(api, config, session, store), new RegExp(reason));
    assert.equal(calls.some(c => c.method === 'createForumTopic'), false);
  }
  const { api, calls } = mock({ sendMessage: () => { throw new Error('Bad Request: message thread not found'); } });
  await provision(api, config, session, store);
  assert.equal(calls.some(c => c.method === 'createForumTopic'), true);
  assert.equal(store.threads.length, 1);
});
test('closed topic is reopened', async () => {
  const store = { threads: [] }; await provision(mock().api, config, session, store);
  let sent = 0;
  const { api, calls } = mock({ sendMessage: () => { if (!sent++) throw new Error('TOPIC_CLOSED'); return {}; } });
  await provision(api, config, session, store);
  assert.equal(calls.some(c => c.method === 'reopenForumTopic'), true);
  assert.equal(calls.some(c => c.method === 'createForumTopic'), false);
});
test('requires pairing, persistent session, forum and admin permissions', async () => {
  await assert.rejects(provision(mock().api, { forumChatId: -100 }, session, { threads: [] }), /Pair/);
  await assert.rejects(provision(mock().api, config, {}, { threads: [] }), /persistent/);
  await assert.rejects(provision(mock({ getChat: () => ({ type: 'channel' }) }).api, config, session, { threads: [] }), /supergroup/);
  await assert.rejects(provision(mock({ getChatMember: () => ({ status: 'member' }) }).api, config, session, { threads: [] }), /administrator/);
});
test('inbound scope excludes other users, chats, topics, General and bots', () => {
  const binding = { chatId: -100, messageThreadId: 42 };
  const message = { chat: { id: -100 }, message_thread_id: 42, from: { id: 7 } };
  assert.equal(accepts(message, binding, 7), true);
  for (const patch of [{ chat: { id: -200 } }, { message_thread_id: 43 }, { message_thread_id: undefined }, { from: { id: 8 } }, { from: { id: 7, is_bot: true } }])
    assert.equal(accepts({ ...message, ...patch }, binding, 7), false);
});
test('only supported outgoing methods receive thread parameter; private mode unchanged', () => {
  const binding = { chatId: -100, messageThreadId: 42 }; const body = { chat_id: -100 };
  for (const method of ['sendMessage', 'sendDocument', 'sendPhoto', 'sendVoice', 'sendChatAction'])
    assert.equal(threadParams(method, body, binding).message_thread_id, 42);
  for (const method of ['editMessageText', 'getUpdates', 'getFile'])
    assert.deepEqual(threadParams(method, body, binding), body);
  assert.deepEqual(threadParams('sendMessage', body), body);
  assert.equal(threadParams('sendDocument', { chat_id: '-100' }, binding).message_thread_id, 42);
});
test('atomic storage and corrupt mappings fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-telegram-test-'));
  try {
    const path = join(dir, 'mapping.json');
    assert.deepEqual(await readJson(path, { threads: [] }), { threads: [] });
    await saveJson(path, { threads: [session] });
    assert.deepEqual(await readJson(path), { threads: [session] });
    await writeFile(path, 'broken');
    await assert.rejects(readJson(path, { threads: [] }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('renames topics canonically and idempotently', async () => {
  const binding = { chatId: -100, messageThreadId: 42, sessionId: 'alpha', topicName: 'old' };
  const calls = [];
  const api = async (method, body) => calls.push({ method, body });
  await renameTopic(api, binding, 'Backend');
  await renameTopic(api, binding, 'Backend');
  assert.equal(calls.length, 1);
  await renameTopic(api, binding, 'Backend', true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { method: 'editForumTopic', body: {
    chat_id: -100, message_thread_id: 42, name: 'π session — Backend',
  } });
  assert.equal(binding.topicName, 'π session — Backend');
  assert.equal(sessionNameFromTopic(binding.topicName), 'Backend');
  assert.equal(sessionNameFromTopic('π — Backend'), 'Backend');
  assert.equal(sessionNameFromTopic('Backend'), 'Backend');
});

test('failed rename preserves the mapping; an already-applied rename repairs it', async () => {
  const binding = { sessionId: 'alpha', topicName: 'old' };
  await assert.rejects(renameTopic(async () => { throw new Error('Forbidden'); }, binding, 'New'), /Forbidden/);
  assert.equal(binding.topicName, 'old');
  await renameTopic(async () => { throw new Error('TOPIC_NOT_MODIFIED'); }, binding, 'New');
  assert.equal(binding.topicName, 'π session — New');
});

test('topic names fit Telegram limit without splitting Unicode codepoints', () => {
  const name = topicNameFor('😀'.repeat(200));
  assert.equal(Array.from(name).length, 128);
  assert.ok(name.startsWith('π session — '));
  assert.ok(name.endsWith('😀'));
});
