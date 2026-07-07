import { $ } from './format';

/** Transient message pill, visible from any scene (VAB, flight, menu). */
export function showToast(text: string): void {
  const area = $('toast-area');
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = text;
  area.appendChild(div);
  while (area.children.length > 5) area.removeChild(area.firstChild!);
  setTimeout(() => div.remove(), 4000);
}
