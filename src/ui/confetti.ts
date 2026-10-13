/** Colours of the confetti pieces (the app's accent, good and warm tones). */
const COLOURS = ['#3462f5', '#26a69a', '#ffb74d', '#ef5350', '#ab47bc', '#ffd54f'];

/**
 * A short, decorative confetti burst from the top of `anchor` (a win worth celebrating). Skipped when the
 * person asked their device for reduced motion; removes itself after the animation; hidden from screen readers.
 */
export function confetti(anchor: HTMLElement, pieces = 60): void {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = anchor.getBoundingClientRect();
  if (r.width === 0) return;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < pieces; i++) {
    const p = document.createElement('span');
    const x = r.left + Math.random() * r.width;
    p.style.left = `${x}px`;
    p.style.top = `${r.top}px`;
    p.style.background = COLOURS[i % COLOURS.length];
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 240}px`);
    p.style.setProperty('--dy', `${120 + Math.random() * 260}px`);
    p.style.setProperty('--rot', `${(Math.random() - 0.5) * 900}deg`);
    p.style.animationDelay = `${Math.random() * 120}ms`;
    layer.append(p);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1800);
}
