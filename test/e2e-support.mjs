import { stat } from 'node:fs/promises';

export function recordMessageEdit(messages, body) {
  const message = messages.find(m => m.message_id === body.message_id);
  if (!message) throw new Error('Bad Request: message to edit not found');
  message.text = body.text;
  return { message_id: message.message_id };
}

// Unix sockets cannot be read as files (readFile returns ENXIO).
export async function isSocketReady(path) {
  try {
    return (await stat(path)).isSocket();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
