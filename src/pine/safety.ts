/**
 * Defence in depth for generated Pine code. The code generator only emits fixed templates, mangled user
 * identifiers (`u12_name`, `f3_name`) and JSON-escaped strings; these checks make sure that stays true.
 */

/** Identifiers that must never appear as tokens in generated code (outside string literals). */
export const FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
  'window', 'self', 'globalThis', 'global', 'document', 'Function', 'eval', 'constructor', 'prototype', '__proto__',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'import', 'require', 'process', 'postMessage',
  'Reflect', 'Proxy', 'Symbol', 'arguments', 'this', 'new', 'with', 'async', 'await', 'localStorage', 'sessionStorage',
  'indexedDB', 'navigator', 'location', 'setTimeout', 'setInterval', 'Worker', 'caches', 'Object', 'Array', 'String',
]);

/** Globals shadowed (as undefined parameters) inside the generated function. `eval` cannot be a strict-mode parameter. */
export const SHADOWED_GLOBALS = [
  'self', 'globalThis', 'window', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'postMessage',
  'importScripts', 'Worker', 'SharedWorker', 'indexedDB', 'localStorage', 'sessionStorage', 'caches', 'navigator',
  'location', 'setTimeout', 'setInterval', 'queueMicrotask', 'Function', 'BroadcastChannel', 'Reflect', 'Proxy',
];

/** Identifier tokens of `js` that are forbidden (string literals are skipped; they are data). */
export function forbiddenReferences(js: string): string[] {
  const found = new Set<string>();
  const token = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`|[A-Za-z_$][\w$]*/g;
  for (const m of js.matchAll(token)) {
    const t = m[0];
    if (t === '`') found.add('`');
    else if (t[0] !== '"' && t[0] !== "'" && FORBIDDEN_IDENTIFIERS.has(t)) found.add(t);
  }
  return [...found];
}
