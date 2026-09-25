// Test-only transport. Never imported by the extension or production dispatcher.
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const str = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  if (!str) return fetchOriginal(input, options);
  try {
    const url = new URL(str);
    if (url.hostname === 'api.telegram.org' && process.env.TEST_TELEGRAM_URL) {
      const base = process.env.TEST_TELEGRAM_URL.replace(/\/$/, '');
      const path = url.pathname.includes('/file/') ? url.pathname : `/${url.pathname.split('/').pop()}`;
      return fetchOriginal(`${base}${path}`, options);
    }
  } catch {}
  return fetchOriginal(input, options);
};

