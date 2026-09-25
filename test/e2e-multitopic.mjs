/**
 * End-to-End Multi-Topic Test for pi-telegram
 *
 * Architecture:
 * - TELEGRAM: Mocked via local HTTP server (simulates getUpdates, sendMessage, sendDocument, etc.)
 * - DISPATCHER: Real production dispatcher.mjs
 * - PI SESSIONS: Real Pi instances running in --mode rpc with real LLM (gpt-5.4-mini)
 * - EXTENSION: Real production index.ts loaded via -e
 *
 * Run: node test/e2e-multitopic.mjs [topicCount (default: 6)]
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const count = Number(process.argv[2] ?? 6);
assert.ok(count >= 1 && count <= 6, 'Topic count must be between 1 and 6');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = await realpath(process.env.PI_RPC_AUDIT_CLI ?? '/usr/local/bin/pi');
const model = process.env.PI_MODEL ?? 'gpt-5.4-mini';

// 1. Verify LLM authentication (OpenAI Codex / GPT)
const sourceAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
const auth = JSON.parse(await readFile(join(sourceAgentDir, 'auth.json'), 'utf8'))['openai-codex'];
assert.ok(auth, 'Login to openai-codex in Pi before running this E2E test');

// 2. Setup isolated temp environment
const tempHome = await mkdtemp(join(tmpdir(), 'pi-telegram-e2e-'));
const agentDir = join(tempHome, '.pi/agent');
const runtimeDir = join(agentDir, 'telegram-runtime');
await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ 'openai-codex': auth }), { mode: 0o600 });
await writeFile(join(agentDir, 'telegram.json'), JSON.stringify({
  botToken: '1:e2e_test',
  botUsername: 'e2e_bot',
  allowedUserId: 7,
  forumChatId: -100,
}), { mode: 0o600 });
await writeFile(join(runtimeDir, 'cursor.json'), JSON.stringify({ botTokenId: '1', offset: 1 }));

// 3. Mock Telegram API (Local HTTP Server)
const files = new Map();
const updates = [];
const topics = new Map(); // topicId -> sessionIndex
const sentMessages = [];
const uploadedDocs = [];
let nextTopicId = 100;
let nextMessageId = 1000;

const mockTelegram = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    // Handle file downloads
    if (url.pathname.startsWith('/file/')) {
      const fileId = url.pathname.split('/').pop();
      assert.ok(files.has(fileId), `File not found: ${fileId}`);
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(files.get(fileId));
    }

    const method = url.pathname.split('/').pop();

    // Read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    let body = {};
    if ((req.headers['content-type'] ?? '').startsWith('multipart/')) {
      const form = await new Response(rawBody, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      body = Object.fromEntries(form);

      const file = form.get('document');
      const topicId = Number(form.get('message_thread_id'));
      const fileBytes = Buffer.from(await file.arrayBuffer());
      uploadedDocs.push({ topicId, name: file.name, bytes: fileBytes });
    } else if (rawBody.length > 0) {
      body = JSON.parse(rawBody.toString('utf8'));
    }

    let result = true;
    switch (method) {
      case 'getMe':
        result = { id: 1, username: 'e2e_bot' };
        break;
      case 'getChat':
        result = { id: -100, type: 'supergroup', is_forum: true };
        break;
      case 'getChatMember':
        result = { status: 'administrator', can_manage_topics: true };
        break;
      case 'createForumTopic': {
        const topicId = ++nextTopicId;
        const index = Number(body.name?.match(/Topic (\d+)/)?.[1]);
        if (index) topics.set(topicId, index);
        result = { message_thread_id: topicId };
        break;
      }
      case 'getUpdates':
        result = updates.filter(u => u.update_id >= (body.offset ?? 0)).slice(0, 50);
        break;
      case 'getFile':
        result = { file_id: body.file_id, file_path: body.file_id };
        break;
      case 'sendMessage': {
        const msgId = ++nextMessageId;
        sentMessages.push({
          message_id: msgId,
          topicId: Number(body.message_thread_id),
          text: body.text,
        });
        result = { message_id: msgId };
        break;
      }
      case 'sendDocument':
        result = { message_id: ++nextMessageId };
        break;
      case 'sendChatAction':
      case 'editMessageText':
      case 'deleteWebhook':
      case 'editForumTopic':
        break;
      default:
        throw new Error(`Unexpected Telegram method in mock: ${method}`);
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

await new Promise(resolve => mockTelegram.listen(0, '127.0.0.1', resolve));
const mockUrl = `http://127.0.0.1:${mockTelegram.address().port}`;
console.log(`[Mock Telegram API] Listening on ${mockUrl}`);

// 4. Helper to manage child processes
const children = [];
const env = {
  ...process.env,
  HOME: tempHome,
  PI_CODING_AGENT_DIR: agentDir,
  TEST_TELEGRAM_URL: mockUrl,
  NODE_OPTIONS: `--import=${join(root, 'test/mock-telegram.mjs')}`,
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  PI_OFFLINE: '1',
};

function spawnProc(name, args, cwd) {
  const p = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  p.procName = name;
  children.push(p);
  return p;
}

const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(predicate, label, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

// 5. Start real Dispatcher
console.log('[Dispatcher] Starting production dispatcher.mjs...');
const dispatcher = spawnProc('dispatcher', [join(root, 'dispatcher.mjs'), runtimeDir], tempHome);
dispatcher.stdout.resume();
await waitFor(async () => {
  try { return (await readFile(join(runtimeDir, 'dispatcher.sock'))), true; } catch { return false; }
}, 'dispatcher.sock socket creation', 10000);
console.log('[Dispatcher] Connected and ready.');

// 6. Start 6 real Pi processes in RPC mode
const agents = [];

function createRpcClient(child, index) {
  let seq = 0;
  const pending = new Map();
  const state = { index, child, settled: 0, finals: [] };

  child.stdout.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk;
    let newline;
    while ((newline = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, newline).trim();
      buf = buf.slice(newline + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'response') {
          const p = pending.get(ev.id);
          if (p) {
            pending.delete(ev.id);
            if (ev.success) p.resolve(ev.data); else p.reject(new Error(ev.error));
          }
        } else if (ev.type === 'agent_settled') {
          state.settled++;
        } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
          const text = ev.message.content?.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
          state.finals.push(text);
        }
      } catch {}
    }
  });

  state.rpc = (type, data = {}) => new Promise((resolve, reject) => {
    const id = `${index}-${++seq}`;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n');
  });

  return state;
}

try {
  console.log(`[Pi Sessions] Launching ${count} real Pi instances (--mode rpc, model: ${model})...`);
  for (let i = 1; i <= count; i++) {
    const workDir = join(tempHome, `work-${i}`);
    await mkdir(workDir);

    const child = spawnProc(`pi-${i}`, [
      cli, '--mode', 'rpc', '--provider', 'openai-codex', '--model', model,
      '--thinking', 'low', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-context-files', '--no-themes', '--no-approve',
      '--tools', 'read,telegram_attach',
      '-e', join(root, 'index.ts'),
      '--name', `Topic ${i}`,
      '--session', join(tempHome, `session-${i}.jsonl`),
      '--system-prompt', 'Bounded integration test. Follow the exact markers requested. Use read and telegram_attach when asked.'
    ], workDir);

    const client = createRpcClient(child, i);
    agents.push(client);

    // Bind to Telegram topic
    await client.rpc('set_auto_retry', { enabled: false });
    await client.rpc('prompt', { message: '/telegram-connect' });
    console.log(`  -> Pi ${i} bound to Telegram`);
  }

  await waitFor(() => topics.size === count, 'all topics registered', 15000);
  console.log(`[Topics] All ${count} topics successfully bound.`);

  // 7. WAVE 1: Simultaneous Text Across All Topics
  console.log(`\n--- WAVE 1: Sending ${count} simultaneous text messages ---`);
  const beforeWave1 = agents.map(a => a.settled);

  for (const [topicId, idx] of topics) {
    const updateId = updates.length + 1;
    updates.push({
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: -100, type: 'supergroup' },
        from: { id: 7 },
        message_thread_id: topicId,
        text: `Integration test. Reply with exactly: RPC_TEST_${idx}_A. Do not use tools.`,
      },
    });
  }

  await waitFor(() => agents.every((a, i) => a.settled > beforeWave1[i]), 'Wave 1 all agents settled', 45000);

  // Assertions for Wave 1
  for (const [topicId, idx] of topics) {
    const marker = `RPC_TEST_${idx}_A`;
    const foundMsg = sentMessages.find(m => m.topicId === topicId && m.text.includes(marker));
    assert.ok(foundMsg, `Wave 1 failed: Topic ${idx} did not receive expected marker ${marker}`);
  }
  console.log(`✔ WAVE 1 PASSED: ${count}/${count} topics correctly received and answered isolated text messages.`);

  // 8. WAVE 2: Simultaneous Bidirectional File Attachments
  console.log(`\n--- WAVE 2: Sending ${count} simultaneous file attachments ---`);
  const beforeWave2 = agents.map(a => a.settled);

  for (const [topicId, idx] of topics) {
    const fileName = `dummy-${idx}.txt`;
    const content = Buffer.from(`DUMMY_TOPIC_${idx}_PAYLOAD_TOKEN_${idx}\n`);
    files.set(fileName, content);

    const updateId = updates.length + 1;
    updates.push({
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: -100, type: 'supergroup' },
        from: { id: 7 },
        message_thread_id: topicId,
        caption: `Read the attached ${fileName} with the read tool. Call telegram_attach once to send it back unchanged. Finish by replying RPC_TEST_${idx}_B`,
        document: { file_id: fileName, file_name: fileName, mime_type: 'text/plain' },
      },
    });
  }

  await waitFor(() => agents.every((a, i) => a.settled > beforeWave2[i]), 'Wave 2 all agents settled', 60000);

  // Assertions for Wave 2
  assert.equal(uploadedDocs.length, count, `Expected ${count} document uploads, got ${uploadedDocs.length}`);

  for (const [topicId, idx] of topics) {
    const upload = uploadedDocs.find(u => u.topicId === topicId);
    assert.ok(upload, `Missing upload for topic ${idx}`);

    const expectedBytes = files.get(`dummy-${idx}.txt`);
    assert.deepEqual(upload.bytes, expectedBytes, `Uploaded content mismatch for topic ${idx}`);

    const marker = `RPC_TEST_${idx}_B`;
    const foundMsg = sentMessages.find(m => m.topicId === topicId && m.text.includes(marker));
    assert.ok(foundMsg, `Missing final text confirmation ${marker} for topic ${idx}`);
  }
  console.log(`✔ WAVE 2 PASSED: ${count}/${count} topics downloaded, read, and returned attachments with exact byte equality.`);

  console.log(`\n🎉 ALL TESTS PASSED: Dispatcher cleanly multiplexed ${count} concurrent topics with text and attachments.`);
} finally {
  console.log('\n[Teardown] Cleaning up processes and temp files...');
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  mockTelegram.closeAllConnections();
  mockTelegram.close();
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
}
