// Persisted debug log (chrome.storage.local, ring buffer) so failures can be
// read from the side panel's Logs view instead of needing devtools open on
// whichever page hit the error. content.js keeps its own inline copy of this
// (classic script, can't import) — keep the key/shape in sync if this changes.
const LOG_KEY = 'ltp_debug_log_v1';
const LOG_MAX = 300;

function stringify(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

async function append(level, source, args) {
  const entry = { ts: new Date().toISOString(), level, source, message: args.map(stringify).join(' ') };
  try {
    const data = await chrome.storage.local.get(LOG_KEY);
    const list = data[LOG_KEY] || [];
    list.push(entry);
    while (list.length > LOG_MAX) list.shift();
    await chrome.storage.local.set({ [LOG_KEY]: list });
  } catch {
    // storage unavailable — the console.* call above still went out
  }
}

export function makeLogger(source) {
  return {
    log: (...args) => {
      console.log(`[LTP:${source}]`, ...args);
      append('log', source, args);
    },
    warn: (...args) => {
      console.warn(`[LTP:${source}]`, ...args);
      append('warn', source, args);
    },
    error: (...args) => {
      console.error(`[LTP:${source}]`, ...args);
      append('error', source, args);
    },
  };
}

export async function getLogEntries() {
  const data = await chrome.storage.local.get(LOG_KEY);
  return data[LOG_KEY] || [];
}

export async function clearLogEntries() {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}
