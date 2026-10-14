const selector =
  '.metric, .card, .sidebar nav button, .sidebar-account, .security, .editor-tab, .secondary, .permission-box';
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let active: HTMLElement | null = null;
let frame: number | null = null;
let x = 0,
  y = 0;
function clear() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  active?.classList.remove('pointer-glow');
  active = null;
}
document.addEventListener('pointermove', (event) => {
  if (!finePointer.matches || event.pointerType === 'touch') return;
  const surface = (event.target as Element).closest<HTMLElement>(selector);
  if (surface !== active) {
    clear();
    active = surface;
    active?.classList.add('pointer-glow');
  }
  if (!active) return;
  x = event.clientX;
  y = event.clientY;
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    if (!active?.isConnected) return clear();
    const box = active.getBoundingClientRect();
    active.style.setProperty(
      '--glow-x',
      `${reducedMotion.matches ? box.width / 2 : x - box.left}px`,
    );
    active.style.setProperty('--glow-y', `${reducedMotion.matches ? 0 : y - box.top}px`);
  });
});
document.addEventListener('pointerout', (event) => {
  if (!event.relatedTarget) clear();
});
document.addEventListener('scroll', clear, true);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clear();
});
window.addEventListener('blur', clear);
finePointer.addEventListener('change', clear);
