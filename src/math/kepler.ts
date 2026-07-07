import * as THREE from 'three';

// Universal-variable two-body propagation (Vallado) plus orbital-element
// extraction for the map view and HUD. All vectors are body-centered inertial.

function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 0.5 - z / 24;
}

function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120;
}

const _r0 = new THREE.Vector3();
const _v0 = new THREE.Vector3();

/**
 * Propagate a two-body state by dt seconds. Handles elliptic, parabolic and
 * hyperbolic orbits, including purely radial trajectories. Falls back to
 * numeric integration if the Newton iteration fails to converge.
 */
export function propagateKepler(
  rIn: THREE.Vector3,
  vIn: THREE.Vector3,
  dt: number,
  mu: number,
  outR: THREE.Vector3,
  outV: THREE.Vector3,
): void {
  const r0 = _r0.copy(rIn);
  const v0 = _v0.copy(vIn);
  if (dt === 0) {
    outR.copy(r0);
    outV.copy(v0);
    return;
  }

  const r0n = r0.length();
  const rDotV = r0.dot(v0);
  const sqrtMu = Math.sqrt(mu);
  const alpha = 2 / r0n - v0.lengthSq() / mu; // 1/a

  // For closed orbits, wrap dt into one period to keep the iteration stable.
  let t = dt;
  if (alpha > 1e-12) {
    const a = 1 / alpha;
    const period = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    t = t % period;
    if (t === 0) {
      outR.copy(r0);
      outV.copy(v0);
      return;
    }
  }

  let chi: number;
  if (alpha > 1e-12) {
    chi = sqrtMu * t * alpha;
  } else if (alpha < -1e-12) {
    const a = 1 / alpha;
    const sign = t >= 0 ? 1 : -1;
    chi =
      sign *
      Math.sqrt(-a) *
      Math.log(
        (-2 * mu * alpha * t) /
          (rDotV + sign * Math.sqrt(-mu * a) * (1 - r0n * alpha)),
      );
    if (!isFinite(chi)) chi = (sqrtMu * t) / r0n;
  } else {
    chi = (sqrtMu * t) / r0n;
  }

  let rNext = r0n;
  let converged = false;
  for (let i = 0; i < 80; i++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z);
    const S = stumpffS(z);
    rNext =
      chi * chi * C + (rDotV / sqrtMu) * chi * (1 - z * S) + r0n * (1 - z * C);
    const F =
      (rDotV / sqrtMu) * chi * chi * C +
      (1 - alpha * r0n) * chi * chi * chi * S +
      r0n * chi -
      sqrtMu * t;
    const d = F / rNext;
    chi -= d;
    if (Math.abs(d) < 1e-8) {
      converged = true;
      break;
    }
  }

  if (!converged || !isFinite(chi)) {
    propagateNumeric(r0, v0, dt, mu, outR, outV);
    return;
  }

  const z = alpha * chi * chi;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - ((chi * chi) / r0n) * C;
  const g = t - ((chi * chi * chi) / sqrtMu) * S;
  outR.copy(r0).multiplyScalar(f).addScaledVector(v0, g);
  const rn = outR.length();
  const gdot = 1 - ((chi * chi) / rn) * C;
  const fdot = (sqrtMu / (rn * r0n)) * chi * (z * S - 1);
  outV.copy(r0).multiplyScalar(fdot).addScaledVector(v0, gdot);

  if (!isFinite(outR.x) || !isFinite(outV.x)) {
    propagateNumeric(r0, v0, dt, mu, outR, outV);
  }
}

const _acc = new THREE.Vector3();

/** Robust fallback: leapfrog integration of the two-body problem. */
function propagateNumeric(
  r0: THREE.Vector3,
  v0: THREE.Vector3,
  dt: number,
  mu: number,
  outR: THREE.Vector3,
  outV: THREE.Vector3,
): void {
  outR.copy(r0);
  outV.copy(v0);
  const n = Math.min(20000, Math.max(200, Math.ceil(Math.abs(dt) / 5)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const r = outR.length();
    _acc.copy(outR).multiplyScalar(-mu / (r * r * r));
    outV.addScaledVector(_acc, h);
    outR.addScaledVector(outV, h);
  }
}

export interface OrbitElements {
  a: number; // semi-major axis (m); negative for hyperbolic
  e: number; // eccentricity
  inc: number; // inclination, rad
  peR: number; // periapsis radius from body center, m
  apR: number; // apoapsis radius, m (Infinity if e >= 1)
  period: number; // s (Infinity if e >= 1)
  semiLatus: number;
  pHat: THREE.Vector3; // unit vector toward periapsis
  qHat: THREE.Vector3; // in-plane, 90° ahead of periapsis
  wHat: THREE.Vector3; // orbit normal
  degenerate: boolean; // true when angular momentum ~ 0 (radial trajectory)
}

export function orbitalElements(
  r: THREE.Vector3,
  v: THREE.Vector3,
  mu: number,
): OrbitElements {
  const rn = r.length();
  const hVec = new THREE.Vector3().crossVectors(r, v);
  const h = hVec.length();
  const energy = v.lengthSq() / 2 - mu / rn;
  const a = Math.abs(energy) > 1e-9 ? -mu / (2 * energy) : Infinity;

  const eVec = new THREE.Vector3()
    .crossVectors(v, hVec)
    .divideScalar(mu)
    .addScaledVector(r, -1 / rn);
  const e = eVec.length();

  const degenerate = h < 1e-3 * rn; // effectively radial
  const semiLatus = (h * h) / mu;
  const peR = degenerate ? 0 : semiLatus / (1 + e);
  const apR = e < 1 && !degenerate ? semiLatus / (1 - e) : Infinity;
  const period =
    e < 1 && isFinite(a) && a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;

  const wHat = degenerate
    ? new THREE.Vector3(0, 1, 0)
    : hVec.clone().divideScalar(h);
  const pHat =
    e > 1e-8 ? eVec.clone().divideScalar(e) : r.clone().divideScalar(rn);
  const qHat = new THREE.Vector3().crossVectors(wHat, pHat);
  const inc = degenerate ? 0 : Math.acos(THREE.MathUtils.clamp(hVec.y / h, -1, 1));

  return { a, e, inc, peR, apR, period, semiLatus, pHat, qHat, wHat, degenerate };
}

export interface OrbitPath {
  points: THREE.Vector3[]; // body-centered inertial
  closed: boolean;
}

/**
 * Sample the conic through (r, v) for drawing in the map view.
 * The path is truncated where it would leave `maxR` (the SOI).
 */
export function sampleOrbit(
  r: THREE.Vector3,
  v: THREE.Vector3,
  mu: number,
  maxR: number,
  n = 240,
): OrbitPath | null {
  const el = orbitalElements(r, v, mu);
  if (el.degenerate) return null;
  const { e, semiLatus: p, pHat, qHat } = el;

  let thetaMin: number;
  let thetaMax: number;
  let closed = false;

  const limitForR = (R: number): number => {
    // r(θ) = p / (1 + e cosθ) <= R  →  cosθ >= (p/R - 1)/e
    if (e < 1e-8) return Math.PI;
    return Math.acos(THREE.MathUtils.clamp((p / R - 1) / e, -1, 1));
  };

  if (e < 1 && el.apR <= maxR) {
    thetaMin = -Math.PI;
    thetaMax = Math.PI;
    closed = true;
  } else {
    const lim = Math.max(0.05, limitForR(maxR) - 1e-3);
    thetaMin = -lim;
    thetaMax = lim;
  }

  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const th = thetaMin + ((thetaMax - thetaMin) * i) / n;
    const rm = p / (1 + e * Math.cos(th));
    if (rm <= 0 || !isFinite(rm) || rm > maxR * 1.05) continue;
    points.push(
      new THREE.Vector3()
        .addScaledVector(pHat, rm * Math.cos(th))
        .addScaledVector(qHat, rm * Math.sin(th)),
    );
  }
  if (points.length < 2) return null;
  return { points, closed };
}
