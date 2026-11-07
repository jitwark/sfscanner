import type { KeyboardEvent } from 'react';

const KEYBOARD_STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function moveKeyboardFocus(event: KeyboardEvent<SVGGElement>) {
  const isNavigationKey = event.key in KEYBOARD_STEPS || event.key === 'Home' || event.key === 'End';
  if (!isNavigationKey) return;
  const nodes = Array.from(event.currentTarget.closest('svg')?.querySelectorAll<SVGGElement>('[data-node-id][tabindex="0"]') ?? []);
  const currentIndex = nodes.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : currentIndex + (KEYBOARD_STEPS[event.key] ?? 0);
  const nextIndex = Math.max(0, Math.min(nodes.length - 1, targetIndex));
  event.preventDefault();
  if (nextIndex !== currentIndex) nodes[nextIndex]?.focus();
}
