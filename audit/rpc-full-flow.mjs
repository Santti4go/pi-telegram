// Real Pi RPC processes + unchanged bridge + real model + LOCAL dummy Telegram.
// Requires a memory-limited systemd user service. See RPC-FULL-FLOW.md.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const count = Number(process.argv[2] ?? 6);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 6, 'Use 1–6 sessions');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = await realpath(process.env.PI_RPC_AUDIT_CLI ?? '/usr/local/bin/pi');
const targetModel = process.env.PI_AUDIT_MODEL ?? 'gpt-5.4-mini';

let cgroup = null;
try {
  const cgroupContent = await readFile('/proc/self/cgroup', 'utf8');
  const group = cgroupContent.trim().split('0::')[1];
  if (group) {
    cgroup = join('/sys/fs/cgroup', group);
    const memoryMax = (await readFile(join(cgroup, 'memory.max'), 'utf8')).trim();
    if (process.env.AUDIT_REQUIRE_CGROUP === '1') {
      assert.ok(memoryMax !== 'max' && Number(memoryMax) <= 3 * 1024 ** 3, 'Run in a cgroup with MemoryMax <= 3G');
      assert.equal((await readFile(join(cgroup, 'memory.swap.max'), 'utf8')).trim(), '0', 'Require MemorySwapMax=0');
    }
  }
} catch (err) {
  if (process.env.AUDIT_REQUIRE_CGROUP === '1') throw err;
  console.log('Notice: running outside restricted systemd cgroup.');
}

const sourceAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
const auth = JSON.parse(await readFile(join(sourceAgentDir, 'auth.json'), 'utf8'))['openai-codex'];
assert.ok(auth, 'Login to openai-codex in Pi before this test');
if (auth.type === 'oauth') {
  assert.ok(Number(auth.expires) > Date.now() + 6 * 60_000,
    'Refresh openai-codex authentication in your normal Pi first; audit will not refresh an expired credential copy');
}
const home = await mkdtemp(join(tmpdir(), 'pi-rpc-audit-home-'));
const output = await mkdtemp(join(tmpdir(), 'pi-rpc-audit-results-'));
const agentDir = join(home, '.pi/agent');
const runtime = join(agentDir, 'telegram-runtime');
const report = { started: new Date().toISOString(), model: `openai-codex/${targetModel}`, sessions: count,
  result: 'running', output, samples: [], topics: [], errors: [], methods: {}, uploads: [], downloads: [], maxPolling: 0 };
console.log(`RESULTS=${output}`);
const children = [], agents = [], topics = new Map(), sent = new Map();
let dispatcher, stopping = false, fatal, timer, sampling = false, polling = 0, nextTopic = 40, nextMessage = 1000;
const updates = [], files = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = error => { fatal ??= error instanceof Error ? error : new Error(String(error)); };
process.on('SIGTERM', () => fail(new Error('SIGTERM: cancelled')));
process.on('SIGINT', () => fail(new Error('SIGINT: cancelled')));
async function waitFor(predicate, label, ms = 120000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fatal) throw fatal; if (await predicate()) return; await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
async function saveReport() { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); }
async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const value = { at: new Date().toISOString(), processes: [] };
    for (const child of children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      const text = await readFile(`/proc/${child.pid}/status`, 'utf8').catch(() => '');
      value.processes.push({ pid: child.pid, role: child.auditRole, rssKiB: Number(text.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) });
    }
    if (cgroup) {
      for (const field of ['memory.current', 'memory.peak', 'memory.events', 'cpu.stat', 'pids.current']) {
        value[field] = (await readFile(join(cgroup, field), 'utf8').catch(() => 'N/A')).trim();
      }
    }
    report.samples.push(value);
    if (report.samples.length > 180) throw new Error('Sample budget exceeded');
    console.log(JSON.stringify({ resources: value }));
    await saveReport();
  } catch (error) { fail(error); } finally { sampling = false; }
}
function spawnTracked(role, args, env, cwd) {
  const child = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  child.auditRole = role; child.stderrTail = '';
  children.push(child);
  child.on('error', fail);
  child.stdin.on('error', error => { if (!stopping) fail(error); });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { child.stderrTail = (child.stderrTail + text).slice(-8000); });
  child.on('exit', (code, signal) => { if (!stopping) fail(new Error(`${role} exited: ${code}/${signal}: ${child.stderrTail}`)); });
  return child;
}
function rpcClient(child, index) {
  const state = { index, child, requests: new Map(), starts: 0, settled: 0, finals: [], tools: [], deltas: 0, seq: 0 };
  let buffer = '', totalBytes = 0;
  child.once('exit', () => {
    for (const pending of state.requests.values()) {
      clearTimeout(pending.timer); pending.reject(new Error(`Pi ${index} exited during RPC`));
    }
    state.requests.clear();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    try {
      totalBytes += Buffer.byteLength(chunk); buffer += chunk;
      assert.ok(totalBytes < 8 * 1024 ** 2 && buffer.length < 1024 ** 2, 'RPC output budget exceeded');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // Ignore non-JSON lines printed to stdout (runtime warnings, etc.)
          continue;
        }
        if (event.type === 'response') {
          const pending = state.requests.get(event.id);
          if (pending) { state.requests.delete(event.id); clearTimeout(pending.timer);
            if (event.success) pending.resolve(event.data); else pending.reject(new Error(event.error)); }
        } else if (event.type === 'agent_start') state.starts++;
        else if (event.type === 'agent_settled') state.settled++;
        else if (event.type === 'message_update') state.deltas++;
        else if (event.type === 'extension_error') fail(new Error(`Pi ${index} extension error: ${event.error}`));
        else if (event.type === 'tool_execution_end') {
          state.tools.push({ name: event.toolName, isError: !!event.isError });
          if (event.isError) fail(new Error(`Pi ${index} tool failed: ${event.toolName}`));
        } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
          if (['error', 'aborted', 'length'].includes(event.message.stopReason))
            fail(new Error(`Pi ${index}: ${event.message.stopReason}: ${event.message.errorMessage ?? ''}`));
          if (event.message.stopReason === 'stop') {
            const text = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
            state.finals.push(text.slice(0, 4096));
            console.log(JSON.stringify({ agent: index, final: text.slice(0, 200) }));
          }
        } else if (event.type === 'extension_ui_request') {
          if (['input', 'select', 'confirm', 'editor'].includes(event.method)) {
            child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true }) + '\n');
            fail(new Error(`Unexpected interactive dialog in Pi ${index}`));
          }
          if (event.notifyType === 'error' || /\berror\b/i.test(event.statusText ?? ''))
            fail(new Error(`Pi ${index} UI error: ${event.message ?? event.statusText}`));
        }
      }
    } catch (error) { fail(error); }
  });
  state.rpc = (type, data = {}) => new Promise((resolve, reject) => {
    const id = `${index}-${++state.seq}`;
    const timeout = setTimeout(() => { state.requests.delete(id); reject(new Error(`RPC timeout: ${type}`)); }, 45000);
    state.requests.set(id, { resolve, reject, timer: timeout });
    child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n');
  });
  return state;
}
const http = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/file/bot1:audit/')) {
      const id = req.url.split('/').pop(); assert.ok(files.has(id), 'Unknown dummy file');
      report.downloads.push(id); res.end(files.get(id)); return;
    }
    assert.ok(req.url.startsWith('/bot1:audit/'), 'Unexpected API path');
    const method = req.url.split('/').pop();
    report.methods[method] = (report.methods[method] ?? 0) + 1;
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; assert.ok(size < 65536, 'Request too large'); chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    let body;
    if ((req.headers['content-type'] ?? '').startsWith('multipart/')) {
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      body = Object.fromEntries(form);
      const file = form.get('document'); assert.ok(file && typeof file.arrayBuffer === 'function', 'Missing document');
      const topic = Number(form.get('message_thread_id'));
      const index = topics.get(topic); assert.ok(index, 'Upload to unknown topic');
      assert.equal(String(form.get('chat_id')), '-100');
      const data = Buffer.from(await file.arrayBuffer());
      assert.deepEqual(data, files.get(`dummy-${index}.txt`), 'Upload contents/topic mismatch');
      report.uploads.push({ topic, index, bytes: data.length, name: file.name });
    } else body = raw.length ? JSON.parse(raw) : {};
    let result = true;
    switch (method) {
      case 'getMe': result = { id: 1, username: 'audit_bot' }; break;
      case 'getChat': result = { type: 'supergroup', is_forum: true }; break;
      case 'getChatMember': result = { status: 'administrator', can_manage_topics: true }; break;
      case 'createForumTopic': {
        const index = Number(body.name.match(/RPC audit (\d+)$/)?.[1]); assert.ok(index >= 1 && index <= count);
        const topic = ++nextTopic; topics.set(topic, index); result = { message_thread_id: topic }; break;
      }
      case 'getUpdates':
        polling++; report.maxPolling = Math.max(report.maxPolling, polling);
        await delay(150);
        result = updates.filter(update => update.update_id >= body.offset).slice(0, 100);
        polling--; break;
      case 'getFile': assert.ok(files.has(body.file_id)); result = { file_path: body.file_id }; break;
      case 'sendMessage': {
        const topic = Number(body.message_thread_id); assert.ok(topics.has(topic), 'Unscoped sendMessage');
        result = { message_id: ++nextMessage };
        sent.set(result.message_id, { topic, text: body.text }); break;
      }
      case 'editMessageText': {
        const previous = sent.get(body.message_id); assert.ok(previous, 'Unknown preview message');
        previous.text = body.text; result = { message_id: body.message_id }; break;
      }
      case 'sendChatAction': assert.ok(topics.has(Number(body.message_thread_id)), 'Unscoped typing'); break;
      case 'sendDocument': result = { message_id: ++nextMessage }; break;
      case 'deleteWebhook': case 'editForumTopic': break;
      default: throw new Error(`Unexpected Telegram method: ${method}`);
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  } catch (error) { fail(error); res.statusCode = 500; res.end(JSON.stringify({ ok: false, description: 'Audit assertion failed' })); }
});
function enqueue(topic, index, stage) {
  const id = updates.length + 1;
  const text = stage === 'A' ? `Dummy integration test. Reply exactly RPC_TEST_${index}_A. Do not call tools.` :
    `Dummy integration test. Read the attached dummy-${index}.txt using read. Then call telegram_attach once with that same downloaded file path to return it unchanged. Final reply exactly RPC_TEST_${index}_B followed by the code from the file. No other tools.`;
  updates.push({ update_id: id, message: { message_id: id, chat: { id: -100, type: 'supergroup' },
    from: { id: 7 }, message_thread_id: topic,
    ...(stage === 'A' ? { text } : { caption: text, document: { file_id: `dummy-${index}.txt`, file_name: `dummy-${index}.txt`, mime_type: 'text/plain' } }) } });
}
try {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ 'openai-codex': auth }), { mode: 0o600 });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'never', transport: 'sse' }));
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'openai-codex': {
        modelOverrides: {
          [targetModel]: { maxTokens: 1024 },
          'gpt-5.6-luna': { maxTokens: 1024 }
        }
      }
    }
  }));
  await writeFile(join(agentDir, 'telegram.json'), JSON.stringify({ botToken: '1:audit', botUsername: 'audit_bot', allowedUserId: 7, forumChatId: -100 }), { mode: 0o600 });
  await writeFile(join(runtime, 'cursor.json'), JSON.stringify({ botTokenId: '1', offset: 1 }));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir,
    PI_AUDIT_TELEGRAM_URL: `http://127.0.0.1:${http.address().port}`,
    NODE_OPTIONS: `--max-old-space-size=256 --import=${join(root, 'audit/rpc-telegram-transport.mjs')}`,
    PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1' };
  dispatcher = spawnTracked('dispatcher', [join(root, 'dispatcher.mjs'), runtime], env, home);
  dispatcher.stdout.resume();
  await waitFor(() => stat(join(runtime, 'dispatcher.sock')).then(() => true, () => false), 'dispatcher socket', 10000);
  timer = setInterval(() => { void sample(); }, 2000);
  for (let index = 1; index <= count; index++) {
    const cwd = join(home, `work-${index}`); await mkdir(cwd);
    files.set(`dummy-${index}.txt`, Buffer.from(`DUMMY_TOPIC_${index}\nOnly synthetic test data.\n`));
    const child = spawnTracked(`pi-${index}`, [cli, '--mode', 'rpc', '--offline', '--provider', 'openai-codex',
      '--model', targetModel, '--thinking', 'low', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-context-files', '--no-themes', '--no-approve', '--tools', 'read,telegram_attach',
      '-e', join(root, 'index.ts'), '-e', join(root, 'audit/rpc-audit-guard.ts'),
      '--session', join(home, `session-${index}.jsonl`), '--name', `RPC audit ${index}`,
      '--system-prompt', 'You are running a bounded dummy integration test. Follow the exact requested markers. Use only read and telegram_attach, only for the provided dummy file. Be concise.'],
    { ...env, PI_AUDIT_DUMMY_NAME: `dummy-${index}.txt` }, cwd);
    const agent = rpcClient(child, index); agents.push(agent);
    const state = await agent.rpc('get_state');
    assert.ok(state.model?.id === targetModel || state.model?.id === 'gpt-5.6-luna', `Unexpected model: ${state.model?.id}`);
    assert.equal(state.model?.provider, 'openai-codex');
    await agent.rpc('set_auto_retry', { enabled: false });
    await agent.rpc('set_auto_compaction', { enabled: false });
    await agent.rpc('prompt', { message: '/telegram-connect' });
    console.log(`READY pi-${index}, pid=${child.pid}`);
  }
  assert.equal(topics.size, count);
  await sample();
  for (const stage of ['A', 'B']) {
    const before = agents.map(agent => agent.settled);
    for (const [topic, index] of topics) enqueue(topic, index, stage);
    console.log(`WAVE ${stage}: ${count} concurrent topic messages`);
    await waitFor(() => agents.every((agent, i) => agent.settled > before[i]), `wave ${stage} settled`);
    for (const [topic, index] of topics) {
      const marker = `RPC_TEST_${index}_${stage}`;
      assert.ok(agents[index - 1].finals.some(text => text.includes(marker) &&
        (stage === 'A' || text.includes(`DUMMY_TOPIC_${index}`))), `Missing Pi final/file code ${marker}`);
      await waitFor(() => [...sent.values()].some(message => message.topic === topic && message.text.includes(marker)), `Telegram delivery ${marker}`, 10000);
    }
  }
  assert.equal(report.uploads.length, count);
  assert.equal(report.downloads.length, count);
  assert.deepEqual([...report.downloads].sort(), [...files.keys()].sort());
  assert.equal(new Set(report.uploads.map(upload => upload.index)).size, count);
  assert.ok(report.methods.sendChatAction >= count, 'Typing not exercised');
  assert.equal(report.maxPolling, 1);
  for (const agent of agents) {
    const state = await agent.rpc('get_state'); assert.equal(state.isStreaming, false);
    assert.equal(state.pendingMessageCount, 0); assert.equal(agent.starts, 2);
    assert.ok(agent.tools.some(tool => tool.name === 'read'));
    assert.ok(agent.tools.some(tool => tool.name === 'telegram_attach'));
    assert.ok(agent.deltas > 0, 'No RPC streaming events');
    const stats = await agent.rpc('get_session_stats'); assert.equal(stats.userMessages, 2);
    report.topics.push({ index: agent.index, starts: agent.starts, settled: agent.settled,
      finals: agent.finals, tools: agent.tools, streamingEvents: agent.deltas, stats });
    await agent.rpc('prompt', { message: '/telegram-disconnect' });
  }
  if (fatal) throw fatal;
  report.result = 'success';
  console.log(`PASS: ${count} real Pi RPC sessions; ${count * 2} dummy turns; ${count} verified file round trips.`);
} catch (error) {
  report.result = 'failed'; report.errors.push(String(error));
  console.error(String(error)); process.exitCode = 1;
} finally {
  stopping = true; clearInterval(timer);
  for (const agent of agents) for (const pending of agent.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Audit cleanup')); }
  // Best-effort graceful process shutdown, followed by a bounded kill of our children only.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await delay(1500);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await delay(200);
  http.closeAllConnections();
  if (http.listening) await new Promise(resolve => http.close(resolve));
  while (sampling) await delay(20);
  await sample();
  report.finished = new Date().toISOString();
  await saveReport();
  await rm(home, { recursive: true, force: true });
  console.log(`REPORT=${join(output, 'report.json')}`);
}
