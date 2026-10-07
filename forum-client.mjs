import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export async function connectForum(session, { onUpdate, onError, onClose }) {
  const dir = join(homedir(), '.pi', 'agent', 'telegram-runtime');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const socketPath = join(dir, 'dispatcher.sock');
  const open = () => new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const fail = e => { socket.destroy(); reject(e); };
    socket.once('error', fail);
    socket.once('connect', () => { socket.removeListener('error', fail); resolve(socket); });
  });
  let socket;
  try { socket = await open(); } catch {
    const child = spawn('flock', ['-n', join(dir, 'dispatcher.lock'), process.execPath,
      fileURLToPath(new URL('./dispatcher.mjs', import.meta.url)), dir], { detached: true, stdio: 'ignore' });
    let spawnError;
    child.on('error', e => { spawnError = e; });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (spawnError) throw new Error(`Cannot start forum dispatcher (requires flock): ${spawnError.message}`);
      try { socket = await open(); break; } catch { /* competing starter may hold the lock */ }
    }
    if (!socket) throw new Error('Cannot reach forum dispatcher. Check Node and flock availability.');
  }
  return new Promise((resolve, reject) => {
    let ready = false;
    let binding;
    let buffer = '';
    let chain = Promise.resolve();
    const timer = setTimeout(() => { reject(new Error('Forum provisioning timed out. Retry /telegram-connect.')); socket.destroy(); }, 180000);
    socket.setEncoding('utf8');
    socket.on('error', e => { if (!ready) reject(e); else onError(e.message); });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!ready) reject(new Error('Forum dispatcher disconnected during provisioning.'));
      else onClose();
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) return socket.destroy();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (message.type === 'ready') {
          ready = true; clearTimeout(timer);
          binding = message.binding;
          resolve({ binding, close: () => socket.destroy(), rename: (name, force = false) => {
            if (socket.destroyed) { onError('Cannot rename topic: dispatcher disconnected.'); return; }
            socket.write(JSON.stringify({ type: 'rename', name, force }) + '\n');
          } });
        } else if (message.type === 'renamed') {
          Object.assign(binding, message.binding);
        } else if (message.type === 'rejected') {
          reject(new Error(message.error)); socket.destroy();
        } else if (message.type === 'error') onError(message.error);
        else if (message.type === 'update') {
          chain = chain.then(() => onUpdate(message.update)).catch(e => onError(e.message));
        }
      }
    });
    socket.write(JSON.stringify(session) + '\n');
  });
}
