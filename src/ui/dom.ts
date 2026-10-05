/** Tiny DOM builder: h('label', { class: 'x' }, 'text', child). Attributes with undefined values are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) el.setAttribute(name, value);
  el.append(...children);
  return el;
}
