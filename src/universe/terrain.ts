import * as THREE from 'three';
import { Body, HOME } from './bodies';

// Deterministic 3D value-noise fBm. The SAME function drives planet mesh
// displacement, texture coloring, and ground collision, so what you see is
// what you land on.

function hashLattice(ix: number, iy: number, iz: number, seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ ix, 2654435761);
  h = Math.imul(h ^ iy, 2246822519);
  h = Math.imul(h ^ iz, 3266489917);
  h ^= h >>> 15;
  h = Math.imul(h, 2654435761);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296; // [0,1)
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Trilinear value noise in [-1, 1]. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const fz = fade(z - iz);

  let v = 0;
  let n000 = hashLattice(ix, iy, iz, seed);
  let n100 = hashLattice(ix + 1, iy, iz, seed);
  let n010 = hashLattice(ix, iy + 1, iz, seed);
  let n110 = hashLattice(ix + 1, iy + 1, iz, seed);
  let n001 = hashLattice(ix, iy, iz + 1, seed);
  let n101 = hashLattice(ix + 1, iy, iz + 1, seed);
  let n011 = hashLattice(ix, iy + 1, iz + 1, seed);
  let n111 = hashLattice(ix + 1, iy + 1, iz + 1, seed);
  const nx00 = n000 + (n100 - n000) * fx;
  const nx10 = n010 + (n110 - n010) * fx;
  const nx01 = n001 + (n101 - n001) * fx;
  const nx11 = n011 + (n111 - n011) * fx;
  const nxy0 = nx00 + (nx10 - nx00) * fy;
  const nxy1 = nx01 + (nx11 - nx01) * fy;
  v = nxy0 + (nxy1 - nxy0) * fz;
  return v * 2 - 1;
}

/** Fractal noise, ~[-1, 1]. */
export function fbm(x: number, y: number, z: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x * freq, y * freq, z * freq, seed + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function seedOf(body: Body): number {
  let h = 2166136261;
  for (let i = 0; i < body.name.length; i++) {
    h ^= body.name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/** Raw fBm height with no launch-site flattening. */
function rawHeight(body: Body, dirFixed: THREE.Vector3): number {
  const t = body.terrain;
  if (!t) return 0;
  return (
    fbm(dirFixed.x * t.scale, dirFixed.y * t.scale, dirFixed.z * t.scale, seedOf(body)) *
      t.amp +
    t.bias
  );
}

/**
 * Find dry land for the launch site: walk the equator outward from the DAWN
 * terminator (longitude 90°: at t=0 the sun sits right on the pad's eastern
 * horizon and rises as Gaia spins) until the terrain is comfortably above
 * sea level in the whole neighborhood. Deterministic, since the noise is
 * seeded — every new game starts at the same site at sunrise.
 */
const _up = new THREE.Vector3(0, 1, 0);

function findPadSite(): { dir: THREE.Vector3; alt: number } {
  const dir = new THREE.Vector3();
  const probe = new THREE.Vector3();
  for (let dphi = 0; dphi < Math.PI; dphi += 0.015) {
    for (const s of dphi === 0 ? [1] : [1, -1]) {
      const phi = Math.PI / 2 + dphi * s;
      dir.set(Math.cos(phi), 0, -Math.sin(phi));
      const h = rawHeight(HOME, dir);
      if (h < 150 || h > 2500) continue;
      // require dry land all around (~12 km ring), not just at the center
      const east = new THREE.Vector3(-Math.sin(phi), 0, -Math.cos(phi));
      let clear = true;
      for (let k = 0; k < 8 && clear; k++) {
        const a = (k / 8) * Math.PI * 2;
        probe
          .copy(dir)
          .addScaledVector(east, Math.cos(a) * 0.02)
          .addScaledVector(_up, Math.sin(a) * 0.02)
          .normalize();
        if (rawHeight(HOME, probe) < 60) clear = false;
      }
      if (clear) return { dir: dir.clone(), alt: h };
    }
  }
  return { dir: new THREE.Vector3(-1, 0, 0), alt: 0 };
}

const PAD_SITE = findPadSite();
/** Body-fixed direction of Gaia's launch site (always on dry land). */
export const PAD_DIR = PAD_SITE.dir;
/** Terrain height the pad plateau is flattened to, m above datum. */
export const PAD_ALT = Math.max(60, PAD_SITE.alt);

/**
 * Terrain height above datum (m) at a body-fixed unit direction.
 * Negative values are below datum (ocean floor on worlds with seas).
 * The area around Gaia's launch site is flattened into a plateau.
 */
export function terrainHeight(body: Body, dirFixed: THREE.Vector3): number {
  const t = body.terrain;
  if (!t) return 0;
  let h = rawHeight(body, dirFixed);
  if (body === HOME) {
    const ang = dirFixed.angleTo(PAD_DIR);
    const f = THREE.MathUtils.smoothstep(ang, 0.006, 0.03);
    h = PAD_ALT * (1 - f) + h * f;
  }
  return h;
}

/** Height of the solid/liquid surface: oceans fill everything below datum. */
export function groundHeight(body: Body, dirFixed: THREE.Vector3): number {
  const h = terrainHeight(body, dirFixed);
  return body.terrain?.ocean ? Math.max(h, 0) : h;
}

/** True when the given spot on the body is water. */
export function isWater(body: Body, dirFixed: THREE.Vector3): boolean {
  return !!body.terrain?.ocean && terrainHeight(body, dirFixed) < 0;
}

const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();

/**
 * Radially displace a sphere geometry by RAW terrain height — ocean floors
 * dip below the datum; the translucent water sphere covers them.
 */
export function displacePlanetGeometry(geo: THREE.SphereGeometry, body: Body): void {
  if (!body.terrain) return;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    _pos.fromBufferAttribute(pos, i);
    _dir.copy(_pos).normalize();
    const h = terrainHeight(body, _dir);
    _pos.copy(_dir).multiplyScalar(body.radius + h);
    pos.setXYZ(i, _pos.x, _pos.y, _pos.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}
