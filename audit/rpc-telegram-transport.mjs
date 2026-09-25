// Test-only preload. Pi can replace global fetch during startup (e.g. proxy support).
// Preserve the Telegram redirect across assignments, leaving model traffic alone.
const base = new URL(process.env.PI_AUDIT_TELEGRAM_URL);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Audit mock must use localhost');
function wrap(delegate) {
  return (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.telegram.org') return delegate(input, options);
    if (!(typeof input === 'string' || input instanceof URL)) throw new Error('Unexpected Telegram Request object');
    if (!/^\/(?:file\/)?bot1:audit\//.test(url.pathname)) throw new Error('Refusing non-audit Telegram bot');
    return delegate(new URL(url.pathname, base), options);
  };
}
let current = wrap(globalThis.fetch);
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  get: () => current,
  set: value => { if (value !== current) current = wrap(value); },
});
