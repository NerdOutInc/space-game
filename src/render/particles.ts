import * as THREE from 'three';
import { makeDotTexture } from './textures';

const COUNT = 500;
const HIDDEN = 1e6;

/**
 * Soft round point shader with PER-PARTICLE size and rgba — smoke needs
 * true alpha fade, which PointsMaterial can't do. Log-depth aware.
 */
function makePointsMaterial(blending: THREE.Blending): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aSize;
      attribute vec4 aColor;
      varying vec4 vColor;
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (520.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec4 vColor;
      void main() {
        #include <logdepthbuf_fragment>
        float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
        float fall = smoothstep(1.0, 0.15, d);
        gl_FragColor = vec4(vColor.rgb, vColor.a * fall);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending,
  });
}

interface PoolOpts {
  count: number;
  blending: THREE.Blending;
}

/** Generic CPU particle pool over the custom point shader. */
class PlumePool {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array; // rgba
  private size: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private baseA: Float32Array;
  private cursor = 0;
  acc = 0;

  constructor(opts: PoolOpts) {
    this.n = opts.count;
    this.pos = new Float32Array(this.n * 3).fill(HIDDEN);
    this.col = new Float32Array(this.n * 4);
    this.size = new Float32Array(this.n);
    this.vel = new Float32Array(this.n * 3);
    this.age = new Float32Array(this.n).fill(1e9);
    this.life = new Float32Array(this.n).fill(1);
    this.baseA = new Float32Array(this.n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geo.setAttribute(
      'aColor',
      new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.geo.setAttribute(
      'aSize',
      new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.points = new THREE.Points(this.geo, makePointsMaterial(opts.blending));
    this.points.frustumCulled = false;
  }

  spawn(
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos[i * 3] = px;
    this.pos[i * 3 + 1] = py;
    this.pos[i * 3 + 2] = pz;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
    this.baseA[i] = a;
  }

  /**
   * Advance. `drift` shifts all particles (world-anchoring in the
   * vessel-centered frame). Smoke mode: velocity damping, size growth and
   * an in/out alpha profile; exhaust mode: fast color cool-down.
   */
  update(dt: number, drift: THREE.Vector3 | null, smoke: boolean): void {
    let alive = false;
    const dx = drift ? drift.x : 0;
    const dy = drift ? drift.y : 0;
    const dz = drift ? drift.z : 0;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.pos[i * 3] = HIDDEN;
        continue;
      }
      alive = true;
      const damp = smoke ? Math.exp(-1.6 * dt) : 1;
      this.vel[i * 3] *= damp;
      this.vel[i * 3 + 1] *= damp;
      this.vel[i * 3 + 2] *= damp;
      this.pos[i * 3] += this.vel[i * 3] * dt - dx;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt - dy;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt - dz;
      const t = this.age[i] / this.life[i];
      if (smoke) {
        this.size[i] += dt * 2.2; // billow
        this.col[i * 4 + 3] =
          this.baseA[i] * Math.min(1, this.age[i] * 6) * (1 - t) * (1 - t * 0.3);
      } else {
        // white-hot → orange → dark ember
        const k = dt / this.life[i];
        this.col[i * 4 + 1] *= Math.exp(-1.9 * k);
        this.col[i * 4 + 2] *= Math.exp(-3.4 * k);
        this.col[i * 4 + 3] = this.baseA[i] * (1 - t * t);
      }
    }
    if (alive || dt > 0) {
      for (const name of ['position', 'aColor', 'aSize'] as const) {
        (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
      }
    }
    this.points.visible = alive;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

const _pv = new THREE.Vector3();
const _pd = new THREE.Vector3();

/**
 * Rocket exhaust: a bright additive jet at each firing nozzle plus a gray
 * smoke trail that only forms in meaningful atmosphere. Both live in the
 * vessel-centered frame; a drift vector keeps them anchored to the air.
 */
export class EnginePlume {
  private exhaust = new PlumePool({ count: 700, blending: THREE.AdditiveBlending });
  private smoke = new PlumePool({ count: 350, blending: THREE.NormalBlending });

  addTo(scene: THREE.Scene): void {
    scene.add(this.exhaust.points);
    scene.add(this.smoke.points);
  }

  /**
   * Emit from one nozzle for this frame. `origin` is in the vessel-centered
   * render frame; `q` orients the stack; `level` 0..1 scales output;
   * `rho` (kg/m³) gates smoke.
   */
  emit(
    dt: number,
    origin: THREE.Vector3,
    q: THREE.Quaternion,
    level: number,
    rho: number,
  ): void {
    if (level <= 0.01 || dt <= 0) return;
    _pd.set(0, -1, 0).applyQuaternion(q); // exhaust direction

    this.exhaust.acc += 650 * level * dt;
    while (this.exhaust.acc >= 1) {
      this.exhaust.acc -= 1;
      const s = 45 + Math.random() * 45;
      _pv.copy(_pd).multiplyScalar(s);
      this.exhaust.spawn(
        origin.x + (Math.random() - 0.5) * 0.6,
        origin.y + (Math.random() - 0.5) * 0.6,
        origin.z + (Math.random() - 0.5) * 0.6,
        _pv.x + (Math.random() - 0.5) * 9,
        _pv.y + (Math.random() - 0.5) * 9,
        _pv.z + (Math.random() - 0.5) * 9,
        0.1 + Math.random() * 0.2,
        1.1 + Math.random() * 1.1,
        1.0,
        0.93,
        0.65,
        0.95,
      );
    }

    const smokeRate = 70 * level * Math.min(1, rho / 0.5);
    if (smokeRate > 1) {
      this.smoke.acc += smokeRate * dt;
      while (this.smoke.acc >= 1) {
        this.smoke.acc -= 1;
        const s = 18 + Math.random() * 14;
        _pv.copy(_pd).multiplyScalar(s);
        const shade = 0.62 + Math.random() * 0.18;
        this.smoke.spawn(
          origin.x + _pd.x * 2 + (Math.random() - 0.5) * 1.2,
          origin.y + _pd.y * 2 + (Math.random() - 0.5) * 1.2,
          origin.z + _pd.z * 2 + (Math.random() - 0.5) * 1.2,
          _pv.x + (Math.random() - 0.5) * 6,
          _pv.y + (Math.random() - 0.5) * 6,
          _pv.z + (Math.random() - 0.5) * 6,
          1.6 + Math.random() * 1.6,
          2.4 + Math.random() * 1.8,
          shade,
          shade,
          shade,
          0.5,
        );
      }
    }
  }

  update(dt: number, drift: THREE.Vector3 | null): void {
    this.exhaust.update(dt, drift, false);
    this.smoke.update(dt, drift, true);
  }

  dispose(): void {
    this.exhaust.dispose();
    this.smoke.dispose();
  }
}

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
