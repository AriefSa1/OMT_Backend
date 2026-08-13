const SENSITIVE_KEY = /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|csrf|credential|private[_-]?key)/i;
const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;

function sanitizeString(value) {
  const text = String(value);
  return text.length > MAX_STRING_LENGTH
    ? `${text.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : text;
}

function sanitizeForHermes(value, key = '', depth = 0) {
  if (SENSITIVE_KEY.test(String(key))) return '[REDACTED]';
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForHermes(item, '', depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[TRUNCATED_ARRAY: ${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    const result = Object.fromEntries(entries.map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeForHermes(entryValue, entryKey, depth + 1),
    ]));
    if (Object.keys(value).length > MAX_OBJECT_KEYS) result._truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
    return result;
  }

  return sanitizeString(value);
}

function sanitizeJson(value, fallback = null) {
  try {
    return JSON.stringify(sanitizeForHermes(value));
  } catch {
    return JSON.stringify(fallback);
  }
}

module.exports = {
  sanitizeForHermes,
  sanitizeJson,
  MAX_STRING_LENGTH,
  MAX_ARRAY_ITEMS,
  MAX_OBJECT_KEYS,
  MAX_DEPTH,
};
