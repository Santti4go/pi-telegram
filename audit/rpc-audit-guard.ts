// Test-only guard. Loaded explicitly alongside the unchanged production bridge.
import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  let toolCalls = 0;
  let turns = 0;
  pi.on('turn_start', (_event, ctx) => {
    if (++turns > 8) ctx.abort();
  });
  pi.on('tool_call', async (event) => {
    const blocked = (reason: string) => ({ block: true, terminate: true, reason });
    if (++toolCalls > 6) return blocked('Audit tool-call budget exceeded');
    let paths: unknown[];
    if (event.toolName === 'read') paths = [event.input.path];
    else if (event.toolName === 'telegram_attach' && Array.isArray(event.input.paths)) paths = event.input.paths;
    else return blocked('Audit allows only read and telegram_attach');
    if (paths.length !== 1) return blocked('Audit expects exactly one dummy file');

    const downloadsDir = join(process.env.HOME || homedir(), '.pi/agent/tmp/telegram');
    await mkdir(downloadsDir, { recursive: true });
    let downloads: string;
    try {
      downloads = await realpath(downloadsDir);
    } catch {
      downloads = downloadsDir;
    }

    for (const input of paths) {
      if (typeof input !== 'string') return blocked('Invalid path');
      try {
        const path = await realpath(input);
        const info = await stat(path);
        const dummyName = process.env.PI_AUDIT_DUMMY_NAME;
        if (dirname(path) !== downloads || (dummyName && !basename(path).endsWith(`-${dummyName}`)) ||
            !info.isFile() || info.size > 1024 * 1024) return blocked('Only this topic dummy download is allowed');
      } catch { return blocked('Dummy file unavailable'); }
    }
  });
}

