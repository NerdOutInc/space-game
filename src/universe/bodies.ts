import * as THREE from 'three';

export interface AtmosphereDef {
  height: number; // m — above this, vacuum
  rho0: number; // sea-level density, kg/m^3
  scaleHeight: number; // m
  skyColor: THREE.Color;
}

export interface TerrainDef {
  amp: number; // m, fBm amplitude
  scale: number; // noise frequency on the unit sphere
  bias: number; // m added to all heights (negative → more ocean)
  ocean: boolean; // fill below-datum terrain with water
}

interface BodyOpts {
  name: string;
  radius: number;
  mu: number; // gravitational parameter, m^3/s^2
  soi: number; // sphere-of-influence radius, m
  rotationPeriod: number; // sidereal, s
  color: number; // base surface color
  colorB: number; // secondary surface color (continents / blotches)
  isStar?: boolean;
  atmosphere?: AtmosphereDef;
  terrain?: TerrainDef;
}

const _tmp = new THREE.Vector3();

export class Body {
  name: string;
  radius: number;
  mu: number;
  soi: number;
  rotationPeriod: number;
  color: number;
  colorB: number;
  isStar: boolean;
  atmosphere?: AtmosphereDef;
  terrain?: TerrainDef;

  parent: Body | null = null;
  orbitRadius = 0;
  orbitPeriod = 0;
  phase0 = 0;
  children: Body[] = [];

  constructor(o: BodyOpts) {
    this.name = o.name;
    this.radius = o.radius;
    this.mu = o.mu;
    this.soi = o.soi;
    this.rotationPeriod = o.rotationPeriod;
    this.color = o.color;
    this.colorB = o.colorB;
    this.isStar = o.isStar ?? false;
    this.atmosphere = o.atmosphere;
    this.terrain = o.terrain;
  }

  /** Highest possible terrain above datum, m (0 for smooth bodies). */
  get maxTerrain(): number {
    return this.terrain ? this.terrain.amp + Math.max(this.terrain.bias, 0) : 0;
  }

  attachTo(parent: Body, orbitRadius: number, phase0 = 0): this {
    this.parent = parent;
    this.orbitRadius = orbitRadius;
    this.phase0 = phase0;
    this.orbitPeriod = 2 * Math.PI * Math.sqrt(orbitRadius ** 3 / parent.mu);
    parent.children.push(this);
    return this;
  }

  orbitAngle(t: number): number {
    return this.phase0 + (2 * Math.PI * t) / this.orbitPeriod;
  }

  /** Position relative to parent body, inertial frame. Zero for the root body. */
  localPosition(t: number, out: THREE.Vector3): THREE.Vector3 {
    if (!this.parent) return out.set(0, 0, 0);
    const a = this.orbitAngle(t);
    return out.set(Math.cos(a) * this.orbitRadius, 0, -Math.sin(a) * this.orbitRadius);
  }

  /** Velocity relative to parent body. */
  localVelocity(t: number, out: THREE.Vector3): THREE.Vector3 {
    if (!this.parent) return out.set(0, 0, 0);
    const a = this.orbitAngle(t);
    const w = (2 * Math.PI) / this.orbitPeriod;
    return out.set(-Math.sin(a), 0, -Math.cos(a)).multiplyScalar(w * this.orbitRadius);
  }

  /** Absolute (root-centered inertial) position. */
  worldPosition(t: number, out: THREE.Vector3): THREE.Vector3 {
    this.localPosition(t, out);
    let b = this.parent;
    while (b) {
      b.localPosition(t, _tmp);
      out.add(_tmp);
      b = b.parent;
    }
    return out;
  }

  rotationAngle(t: number): number {
    return (2 * Math.PI * t) / this.rotationPeriod;
  }

  /** Spin angular rate, rad/s (about +Y). */
  get spinRate(): number {
    return (2 * Math.PI) / this.rotationPeriod;
  }

  surfaceGravity(): number {
    return this.mu / (this.radius * this.radius);
  }
}

// ---- The Zenith system (KSP-scale: small, forgiving, fun) ----

export const HELIOS = new Body({
  name: 'Helios',
  radius: 261_600_000,
  mu: 1.1723328e18,
  soi: Infinity,
  rotationPeriod: 432_000,
  color: 0xffd66b,
  colorB: 0xff9d3a,
  isStar: true,
});

export const GAIA = new Body({
  name: 'Gaia',
  radius: 600_000,
  mu: 3.5316e12, // surface gravity 9.81 m/s^2
  soi: 84_159_286,
  rotationPeriod: 21_600, // 6-hour day
  color: 0x2e62c9,
  colorB: 0x3f9152,
  atmosphere: {
    height: 70_000,
    rho0: 1.225,
    scaleHeight: 5_600,
    skyColor: new THREE.Color(0x6fb4ff),
  },
  terrain: { amp: 6_500, scale: 2.4, bias: -800, ocean: true },
}).attachTo(HELIOS, 13_599_840_256, 0.0);

export const LUNA = new Body({
  name: 'Luna',
  radius: 200_000,
  mu: 6.5138398e10,
  soi: 2_429_559,
  rotationPeriod: 138_984, // tidally locked
  color: 0x9aa0a8,
  colorB: 0x6f747c,
  terrain: { amp: 9_000, scale: 3.4, bias: 500, ocean: false },
}).attachTo(GAIA, 12_000_000, 1.7);

export const EMBER = new Body({
  name: 'Ember',
  radius: 700_000,
  mu: 8.1717302e12,
  soi: 85_109_365,
  rotationPeriod: 80_500,
  color: 0x9a5fc4,
  colorB: 0x6d3b93,
  atmosphere: {
    height: 90_000,
    rho0: 5.0,
    scaleHeight: 7_000,
    skyColor: new THREE.Color(0xc9a0e8),
  },
  terrain: { amp: 7_000, scale: 2.2, bias: -1_500, ocean: true },
}).attachTo(HELIOS, 9_832_684_544, 2.4);

export const ARES = new Body({
  name: 'Ares',
  radius: 320_000,
  mu: 3.0136321e11,
  soi: 47_921_949,
  rotationPeriod: 65_517,
  color: 0xc9603b,
  colorB: 0x8f3f24,
  atmosphere: {
    height: 50_000,
    rho0: 0.2,
    scaleHeight: 8_000,
    skyColor: new THREE.Color(0xd8a07a),
  },
  terrain: { amp: 12_000, scale: 2.8, bias: 1_000, ocean: false },
}).attachTo(HELIOS, 20_726_155_264, 4.4);

export const BODIES: Body[] = [HELIOS, GAIA, LUNA, EMBER, ARES];
export const HOME = GAIA;
