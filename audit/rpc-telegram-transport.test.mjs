import test from 'node:test';
import assert from 'node:assert/strict';

test('Telegram-only redirect survives fetch replacement; no real credentials or network', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const previous = process.env.PI_AUDIT_TELEGRAM_URL;
  const calls = [];
  try {
    process.env.PI_AUDIT_TELEGRAM_URL = 'http://127.0.0.1:12345';
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return new Response('ok'); };
    await import('./rpc-telegram-transport.mjs');
    await fetch('https://api.telegram.org/bot1:audit/sendMessage', { method: 'POST' });
    assert.equal(calls.at(-1).url, 'http://127.0.0.1:12345/bot1:audit/sendMessage');
    const old = globalThis.fetch;
    globalThis.fetch = (url, options) => old(url, options); // Simulated Pi startup replacement.
    await fetch('https://api.telegram.org/file/bot1:audit/dummy.txt');
    assert.equal(calls.at(-1).url, 'http://127.0.0.1:12345/file/bot1:audit/dummy.txt');
    await fetch('https://model.example/v1/responses');
    assert.equal(calls.at(-1).url, 'https://model.example/v1/responses');
    assert.throws(() => fetch('https://api.telegram.org/botREAL:TOKEN/sendMessage'), /Refusing/);
    assert.equal(calls.length, 3);
  } finally {
    Object.defineProperty(globalThis, 'fetch', descriptor);
    if (previous === undefined) delete process.env.PI_AUDIT_TELEGRAM_URL; else process.env.PI_AUDIT_TELEGRAM_URL = previous;
  }
});
