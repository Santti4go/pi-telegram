import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSocketReady, recordMessageEdit } from './test/e2e-support.mjs';

test('E2E readiness recognizes Unix sockets, not missing or ordinary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2e-ready-'));
  const path = join(dir, 'dispatcher.sock');
  const server = createServer();
  try {
    assert.equal(await isSocketReady(path), false);
    await writeFile(path, 'not a socket');
    assert.equal(await isSocketReady(path), false);
    await rm(path);
    await new Promise(resolve => server.listen(path, resolve));
    assert.equal(await isSocketReady(path), true);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('E2E assertions see final streamed edits in the original topic', () => {
  const messages = [{ message_id: 99, topicId: 42, text: 'RPC_TEST_' }];
  assert.deepEqual(recordMessageEdit(messages, { message_id: 99, text: 'RPC_TEST_1_A' }),
    { message_id: 99 });
  assert.deepEqual(messages, [{ message_id: 99, topicId: 42, text: 'RPC_TEST_1_A' }]);
  assert.throws(() => recordMessageEdit(messages, { message_id: 100, text: 'missing' }),
    /message to edit not found/);
});

test('E2E runner reaches Pi startup and cleans up when Pi exits', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2e-failure-'));
  const agentDir = join(dir, '.pi/agent');
  const tempDir = join(dir, 'temp');
  const cli = join(dir, 'fail-cli.mjs');
  let child;
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(tempDir);
    // No real model, credentials or Telegram traffic: Pi exits before any RPC.
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'test' } }));
    await writeFile(cli, 'process.stderr.write("intentional test failure\\n"); process.exit(1);\n');
    child = spawn(process.execPath, [fileURLToPath(new URL('./test/e2e-multitopic.mjs', import.meta.url)), '1'], {
      env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: agentDir, TMPDIR: tempDir,
        PI_RPC_AUDIT_CLI: cli, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 1, errors);
    assert.match(output, /Dispatcher\] Connected and ready/);
    assert.match(output, /Teardown/);
    assert.match(errors, /Pi 1 exited/);
    assert.deepEqual(await readdir(tempDir), [], 'runner must remove its temporary home on failure');
  } finally {
    child?.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
