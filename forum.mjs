import { readFile, writeFile, rename } from 'node:fs/promises';

const THREADED_METHODS = new Set([
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendVideo', 'sendAudio', 'sendChatAction',
]);

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function saveJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}
export function routeKey(chatId, threadId) { return `${chatId}:${threadId}`; }
export function accepts(message, binding, userId) {
  return !!message && !message.from?.is_bot && message.from?.id === userId &&
    message.chat.id === binding.chatId && message.message_thread_id === binding.messageThreadId;
}
export function threadParams(method, body, binding) {
  return binding && String(body.chat_id) === String(binding.chatId) && THREADED_METHODS.has(method)
    ? { ...body, message_thread_id: binding.messageThreadId } : body;
}
export function topicNameFor(name) {
  return Array.from(`π session — ${name}`).slice(0, 128).join('');
}
export function sessionNameFromTopic(topicName) {
  return topicName.replace(/^π(?:\s+session)?\s*[—–-]\s*/u, '').trim() || topicName.trim();
}
export async function renameTopic(api, binding, name, force = false) {
  const topicName = topicNameFor(name || binding.sessionId);
  if (!force && binding.topicName === topicName) return;
  try {
    await api('editForumTopic', { chat_id: binding.chatId, message_thread_id: binding.messageThreadId, name: topicName });
  } catch (e) {
    // A prior API call may have succeeded before the local mapping was saved.
    if (!/TOPIC_NOT_MODIFIED/i.test(e.message)) throw e;
  }
  binding.topicName = topicName;
}
export async function provision(api, config, session, store) {
  if (config.allowedUserId === undefined) throw new Error('Pair your account in private mode first (allowedUserId is required).');
  if (!session.sessionFile || !session.sessionId) throw new Error('Forum topics require a persistent Pi session.');
  const chatId = config.forumChatId;
  const chat = await api('getChat', { chat_id: chatId });
  if (chat.type !== 'supergroup' || !chat.is_forum) throw new Error('forumChatId must identify a forum-enabled supergroup, not a channel.');
  const bot = await api('getMe', {});
  const member = await api('getChatMember', { chat_id: chatId, user_id: bot.id });
  if (member.status !== 'creator' && !(member.status === 'administrator' && member.can_manage_topics))
    throw new Error('Make the bot an administrator with can_manage_topics.');
  const index = store.threads.findIndex(t => t.botId === bot.id && t.chatId === chatId && t.sessionFile === session.sessionFile && t.sessionId === session.sessionId);
  let binding = store.threads[index];
  if (binding) {
    try {
      try {
        await api('sendMessage', { chat_id: chatId, message_thread_id: binding.messageThreadId, text: 'π session reconnected.' });
      } catch (e) {
        if (!/TOPIC_CLOSED/i.test(e.message)) throw e;
        await api('reopenForumTopic', { chat_id: chatId, message_thread_id: binding.messageThreadId });
        await api('sendMessage', { chat_id: chatId, message_thread_id: binding.messageThreadId, text: 'π session reconnected.' });
      }
      await renameTopic(api, binding, session.name || session.sessionId);
      return binding;
    } catch (e) {
      if (!/message thread not found|MESSAGE_THREAD_NOT_FOUND|TOPIC_ID_INVALID/i.test(e.message)) throw e;
    }
  }
  const topicName = topicNameFor(session.name || session.sessionId);
  const topic = await api('createForumTopic', { chat_id: chatId, name: topicName });
  binding = { botId: bot.id, chatId, sessionFile: session.sessionFile, sessionId: session.sessionId,
    messageThreadId: topic.message_thread_id, topicName, createdAt: new Date().toISOString() };
  if (index < 0) store.threads.push(binding); else store.threads[index] = binding;
  return binding;
}
