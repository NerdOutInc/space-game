import * as THREE from 'three';
import { Body } from '../universe/bodies';
import { terrainHeight } from '../universe/terrain';

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

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _out = new THREE.Color();

/**
 * Planet texture painted from the SAME terrain heightfield that displaces
 * the mesh and drives collision: oceans below datum, shaded land, snow on
 * the peaks. UV→direction matches Three's SphereGeometry mapping.
 */
export function makeBodyTexture(body: Body): THREE.CanvasTexture {
  const w = body.terrain ? 640 : 512;
  const h = w / 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(hashName(body.name));

  const base = new THREE.Color(body.color);
  const land = new THREE.Color(body.colorB);

  if (body.terrain) {
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const dir = new THREE.Vector3();
    const t = body.terrain;
    // Below datum is SEABED — the translucent water sphere renders above it,
    // so depth reads through the water: sandy shallows fading to dark floor.
    const seabedShallow = new THREE.Color(0xb09d78);
    const seabedDeep = base.clone().multiplyScalar(0.22).lerp(_c1.set(0x06090f), 0.4);
    const highLand = land.clone().lerp(_c1.set(0xffffff), 0.15).multiplyScalar(0.8);
    const snow = new THREE.Color(0xe9eef4);
    for (let py = 0; py < h; py++) {
      const theta = ((py + 0.5) / h) * Math.PI; // from +Y pole
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      for (let px = 0; px < w; px++) {
        const phi = ((px + 0.5) / w) * Math.PI * 2;
        dir.set(-Math.cos(phi) * sinT, cosT, Math.sin(phi) * sinT);
        const height = terrainHeight(body, dir);
        if (t.ocean && height <= 0) {
          const d = Math.min(1, -height / (t.amp * 0.6));
          _out.copy(seabedShallow).lerp(seabedDeep, Math.pow(d, 0.6));
        } else {
          const f = THREE.MathUtils.clamp(height / (t.amp * 0.95), 0, 1);
          _out.copy(land).lerp(highLand, f);
          // beaches on ocean worlds
          if (t.ocean && height < 250) _out.lerp(_c2.set(0xd8c9a0), 0.5);
          // snow above the snow line
          if (f > 0.62) _out.lerp(snow, THREE.MathUtils.smoothstep(f, 0.62, 0.85));
        }
        // subtle per-pixel grain
        const g = 0.94 + rand() * 0.12;
        const i = (py * w + px) * 4;
        data[i] = Math.min(255, _out.r * 255 * g);
        data[i + 1] = Math.min(255, _out.g * 255 * g);
        data[i + 2] = Math.min(255, _out.b * 255 * g);
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  } else {
    ctx.fillStyle = `#${base.getHexString()}`;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = `#${land.getHexString()}`;
    for (let i = 0; i < 110; i++) {
      ctx.globalAlpha = 0.25 + rand() * 0.5;
      const x = rand() * w;
      const y = h * 0.08 + rand() * h * 0.84;
      const rx = 8 + rand() * 60;
      const ry = 5 + rand() * 35;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x - w, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Polar caps for worlds with atmosphere (reads as ice)
  if (body.atmosphere && !body.isStar) {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#e8f0f8';
    const cap = Math.round(h * 0.05);
    for (const top of [true, false]) {
      for (let x = 0; x < w; x += 6) {
        const jitter = rand() * cap * 0.6;
        if (top) ctx.fillRect(x, 0, 6, cap - jitter + 3);
        else ctx.fillRect(x, h - (cap - jitter + 3), 6, cap - jitter + 3);
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
      const len = 40 + rand() * 140;
      ctx.fillRect(x, y, len, 2 + rand() * 4);
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
