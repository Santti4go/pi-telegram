// Test-only client for exercising the real extension's incoming-update handler.
export async function connectForum(_session, { onUpdate }) {
  const state = globalThis.__telegramExtensionTest;
  state.onUpdate = onUpdate;
  return {
    binding: { chatId: -100, messageThreadId: 42, topicName: 'π session — old' },
    close() {},
    rename(name, force) { state.renames.push({ name, force }); },
  };
}
