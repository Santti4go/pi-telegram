// Test-only transport. Never imported by the extension or production dispatcher.
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (url, options) => fetchOriginal(`${process.env.TEST_TELEGRAM_URL}/${String(url).split('/').pop()}`, options);
