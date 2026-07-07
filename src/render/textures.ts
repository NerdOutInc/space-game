import * as THREE from 'three';
import { Body } from '../universe/bodies';

/** Deterministic PRNG so each body always looks the same. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function makeBodyTexture(body: Body): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(hashName(body.name));

  const base = new THREE.Color(body.color);
  const alt = new THREE.Color(body.colorB);
  ctx.fillStyle = `#${base.getHexString()}`;
  ctx.fillRect(0, 0, w, h);

  // Continents / blotches
  ctx.fillStyle = `#${alt.getHexString()}`;
  for (let i = 0; i < 110; i++) {
    ctx.globalAlpha = 0.25 + rand() * 0.5;
    const x = rand() * w;
    const y = h * 0.08 + rand() * h * 0.84;
    const rx = 12 + rand() * 90;
    const ry = 8 + rand() * 55;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    // wrap horizontally so the seam isn't obvious
    ctx.beginPath();
    ctx.ellipse(x - w, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Speckle detail
  const dark = base.clone().multiplyScalar(0.75);
  ctx.fillStyle = `#${dark.getHexString()}`;
  for (let i = 0; i < 900; i++) {
    ctx.globalAlpha = 0.1 + rand() * 0.25;
    const x = rand() * w;
    const y = rand() * h;
    const r = 1 + rand() * 4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Polar caps for worlds with atmosphere (reads as ice)
  if (body.atmosphere && !body.isStar) {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#e8f0f8';
    for (const yy of [0, h - 26]) {
      for (let x = 0; x < w; x += 8) {
        const jitter = rand() * 14;
        ctx.fillRect(x, yy === 0 ? 0 : yy + jitter - 14, 8, 26 - jitter + 6);
      }
    }
  }

  // Soft cloud streaks
  if (body.atmosphere) {
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 40; i++) {
      const y = rand() * h;
      const x = rand() * w;
      const len = 60 + rand() * 220;
      ctx.fillRect(x, y, len, 3 + rand() * 6);
    }
  }

  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export function makeStarfield(radius: number, count = 2600): THREE.Points {
  const positions = new Float32Array(count * 3);
  const rand = mulberry32(1234567);
  for (let i = 0; i < count; i++) {
    // uniform on a sphere
    const u = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    positions[i * 3] = s * Math.cos(phi) * radius;
    positions[i * 3 + 1] = u * radius;
    positions[i * 3 + 2] = s * Math.sin(phi) * radius;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

/** Small round dot texture for map markers. */
export function makeDotTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}
