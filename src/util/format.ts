export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

export function fmtDist(m: number): string {
  if (!isFinite(m)) return '—';
  const abs = Math.abs(m);
  if (abs < 10_000) return `${m.toFixed(0)} m`;
  if (abs < 1e7) return `${(m / 1000).toFixed(1)} km`;
  if (abs < 1e10) return `${(m / 1e6).toFixed(2)} Mm`;
  return `${(m / 1e9).toFixed(2)} Gm`;
}

export function fmtSpeed(v: number): string {
  if (!isFinite(v)) return '—';
  if (Math.abs(v) < 10) return `${v.toFixed(1)} m/s`;
  if (Math.abs(v) < 10_000) return `${v.toFixed(0)} m/s`;
  return `${(v / 1000).toFixed(2)} km/s`;
}

export function fmtTime(s: number): string {
  if (!isFinite(s)) return '—';
  s = Math.floor(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => x.toString().padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}

export function fmtMass(kg: number): string {
  return `${(kg / 1000).toFixed(2)} t`;
}
