import * as THREE from 'three';
import { makeDotTexture } from './textures';

const COUNT = 500;
const HIDDEN = 1e6;

/**
 * Reentry spark/plasma particles. Lives in the vessel-centered flight scene:
 * particles spawn on the craft's skin (biased toward the end meeting the
 * airflow) and stream downstream, cooling from white-hot to ember-red.
 * Additive blending, so fading to black fades them out.
 */
export class ReentryParticles {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private cursor = 0;
  private acc = 0;
  private _v = new THREE.Vector3();

  constructor() {
    this.pos = new Float32Array(COUNT * 3).fill(HIDDEN);
    this.col = new Float32Array(COUNT * 3);
    this.vel = new Float32Array(COUNT * 3);
    this.age = new Float32Array(COUNT).fill(1e9);
    this.life = new Float32Array(COUNT).fill(1);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geo.setAttribute(
      'color',
      new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage),
    );
    const mat = new THREE.PointsMaterial({
      size: 0.85,
      map: makeDotTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  private spawnOne(
    q: THREE.Quaternion,
    height: number,
    leadTop: boolean,
    downstream: THREE.Vector3,
    speedSpread: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % COUNT;
    // skin point, biased toward the leading end
    const a = Math.random() * Math.PI * 2;
    const r = 0.45 + Math.random() * 0.55;
    const leadY = leadTop ? height / 2 : -height / 2;
    const along = Math.random() * Math.random() * height * 0.9;
    const y = leadY + (leadTop ? -along : along);
    this._v.set(Math.cos(a) * r, y, Math.sin(a) * r).applyQuaternion(q);
    this.pos[i * 3] = this._v.x;
    this.pos[i * 3 + 1] = this._v.y;
    this.pos[i * 3 + 2] = this._v.z;
    const s = 22 + Math.random() * speedSpread;
    this.vel[i * 3] = downstream.x * s + (Math.random() - 0.5) * 14;
    this.vel[i * 3 + 1] = downstream.y * s + (Math.random() - 0.5) * 14;
    this.vel[i * 3 + 2] = downstream.z * s + (Math.random() - 0.5) * 14;
    this.age[i] = 0;
    this.life[i] = 0.25 + Math.random() * 0.4;
    // white-hot at birth
    this.col[i * 3] = 1.0;
    this.col[i * 3 + 1] = 0.72 + Math.random() * 0.25;
    this.col[i * 3 + 2] = 0.42 + Math.random() * 0.2;
  }

  /** One-off shower (a part burning away). */
  burst(
    n: number,
    q: THREE.Quaternion,
    height: number,
    leadTop: boolean,
    downstream: THREE.Vector3,
  ): void {
    for (let k = 0; k < n; k++) this.spawnOne(q, height, leadTop, downstream, 130);
  }

  /**
   * Advance and (maybe) emit. `rate` is particles/second; `downstream` is
   * the world-space direction the airflow sweeps past the craft, or null
   * when there's no meaningful airflow.
   */
  update(
    dt: number,
    rate: number,
    q: THREE.Quaternion,
    height: number,
    leadTop: boolean,
    downstream: THREE.Vector3 | null,
  ): void {
    let alive = false;
    for (let i = 0; i < COUNT; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.pos[i * 3] = HIDDEN;
        continue;
      }
      alive = true;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      // cool: blue/green channels die faster → orange → ember → gone
      const k = dt / this.life[i];
      this.col[i * 3] *= Math.exp(-1.7 * k);
      this.col[i * 3 + 1] *= Math.exp(-3.2 * k);
      this.col[i * 3 + 2] *= Math.exp(-5.0 * k);
    }
    if (rate > 0 && downstream && dt > 0) {
      this.acc = Math.min(this.acc + rate * dt, 80);
      while (this.acc >= 1) {
        this.acc -= 1;
        this.spawnOne(q, height, leadTop, downstream, 55);
        alive = true;
      }
    }
    this.points.visible = alive;
    if (alive || dt > 0) {
      (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
