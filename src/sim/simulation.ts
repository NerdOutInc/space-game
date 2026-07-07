import * as THREE from 'three';
import { propagateKepler } from '../math/kepler';
import { GameState } from '../state';
import { groundHeight, isWater } from '../universe/terrain';
import { BoosterInstance, PartInstance, Vessel } from '../vessel/vessel';
import { Autopilot } from './autopilot';

export interface Controls {
  pitch: number; // -1..1
  yaw: number;
  roll: number;
}

export const WARP_LEVELS = [1, 2, 4, 10, 50, 100, 1000, 10000];
const MAX_DT = 1 / 50;
const ANG_ACCEL = 1.2; // rad/s^2 from reaction wheels
const MAX_ANG_VEL = 2.0;
const SAFE_LANDING_SPEED = 15; // m/s

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _up = new THREE.Vector3();
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _dq = new THREE.Quaternion();

export class Simulation {
  warp = 1;
  vessel: Vessel;
  autopilot = new Autopilot();
  /** Parts dropped by autopilot staging, for the scene to turn into debris. */
  dropped: PartInstance[][] = [];
  droppedBoosters: BoosterInstance[][] = [];
  private state: GameState;

  constructor(vessel: Vessel, state: GameState) {
    this.vessel = vessel;
    this.state = state;
    if (vessel.landed) this.syncLanded();
  }

  /** Universal time lives on the shared game state. */
  get t(): number {
    return this.state.t;
  }
  set t(v: number) {
    this.state.t = v;
  }

  requestWarp(dir: 1 | -1): string | null {
    const i = WARP_LEVELS.indexOf(this.warp);
    const next = WARP_LEVELS[THREE.MathUtils.clamp(i + dir, 0, WARP_LEVELS.length - 1)];
    if (next === this.warp) return null;
    if (next > 4 && !this.vessel.landed && !this.canRailsWarp()) {
      return 'Cannot warp above 4× while thrusting or inside the atmosphere';
    }
    this.warp = next;
    return `Time warp ${next}×`;
  }

  private canRailsWarp(): boolean {
    const v = this.vessel;
    const alt = v.pos.length() - v.body.radius;
    const minAlt = v.body.atmosphere
      ? v.body.atmosphere.height
      : v.body.maxTerrain + 4000;
    const thrusting = v.throttle > 1e-3 && v.firingEngines(0).length > 0;
    return alt > minAlt && !thrusting;
  }

  step(frameDt: number, ctrl: Controls): string[] {
    const msgs: string[] = [];
    const v = this.vessel;

    if (v.destroyed) {
      this.t += frameDt;
      return msgs;
    }

    if (this.autopilot.active) msgs.push(...this.autopilot.update(this));
    const dt = frameDt * this.warp;

    if (v.landed) {
      this.t += dt;
      this.syncLanded();
      this.tryLiftoff(frameDt, msgs);
      return msgs;
    }

    if (this.warp > 4) {
      // On rails: pure two-body propagation, in chunks so we can catch
      // atmosphere entry / impact / SOI changes mid-warp.
      const chunks = 8;
      for (let i = 0; i < chunks; i++) {
        propagateKepler(v.pos, v.vel, dt / chunks, v.body.mu, v.pos, v.vel);
        this.t += dt / chunks;
        this.checkSOI(msgs);
        const alt = v.pos.length() - v.body.radius;
        const limit =
          (v.body.atmosphere ? v.body.atmosphere.height : v.body.maxTerrain + 4000) +
          2000;
        if (alt < limit) {
          this.warp = 1;
          msgs.push('Approaching the surface — warp cancelled');
          break;
        }
      }
      this.checkGround(msgs);
      return msgs;
    }

    const n = Math.min(Math.ceil(dt / MAX_DT), 300);
    const h = dt / n;
    for (let i = 0; i < n && !v.destroyed && !v.landed; i++) {
      this.substep(h, ctrl, msgs);
      this.t += h;
    }
    this.checkSOI(msgs);
    return msgs;
  }

  private substep(h: number, ctrl: Controls, msgs: string[]): void {
    const v = this.vessel;
    const b = v.body;
    const r = v.pos.length();
    const alt = r - b.radius;

    if (this.autopilot.active && this.autopilot.desiredDir) {
      this.steerToward(h, this.autopilot.desiredDir);
    } else {
      this.applyAttitude(h, ctrl);
    }

    // Gravity
    _acc.copy(v.pos).multiplyScalar(-b.mu / (r * r * r));

    // Atmosphere
    let pressureRatio = 0;
    let rho = 0;
    if (b.atmosphere && alt < b.atmosphere.height) {
      pressureRatio = Math.exp(-Math.max(0, alt) / b.atmosphere.scaleHeight);
      rho = b.atmosphere.rho0 * pressureRatio;
    }

    const m = v.mass();

    // Thrust along the stack's local +Y
    const thrust = v.totalThrust(pressureRatio);
    if (thrust > 0) {
      _t1.set(0, 1, 0).applyQuaternion(v.q);
      _acc.addScaledVector(_t1, thrust / m);
    }
    if (v.anyEngineIgnited() && v.burn(h, pressureRatio)) {
      msgs.push('Flameout — stage out of propellant');
    }

    // Armed parachutes pop automatically once it's safe-ish: in atmosphere,
    // below 40 km, and descending.
    if (b.atmosphere && alt < 40_000 && v.pos.dot(v.vel) < 0) {
      for (const p of v.parts) {
        if (p.def.type === 'parachute' && p.armed && !p.deployed) {
          p.deployed = true;
          p.armed = false;
          msgs.push('Parachute deployed!');
        }
      }
    }

    // Drag (relative to the co-rotating atmosphere)
    if (rho > 0) {
      _spin.set(0, b.spinRate, 0);
      _t2.crossVectors(_spin, v.pos); // atmosphere velocity
      _t3.copy(v.vel).sub(_t2); // airspeed
      const va = _t3.length();
      if (va > 0.1) {
        _acc.addScaledVector(_t3, (-0.5 * rho * va * v.dragArea()) / m);
      }
    }

    v.vel.addScaledVector(_acc, h);
    v.pos.addScaledVector(v.vel, h);

    this.checkGround(msgs);
  }

  /** Autopilot steering: rotate the stack's +Y toward `target` at a fixed rate. */
  private steerToward(h: number, target: THREE.Vector3): void {
    const v = this.vessel;
    _t1.set(0, 1, 0).applyQuaternion(v.q);
    const angle = _t1.angleTo(target);
    if (angle > 1e-4) {
      const step = Math.min(angle, 0.45 * h);
      _t2.crossVectors(_t1, target);
      if (_t2.lengthSq() < 1e-12) _t2.set(1, 0, 0);
      else _t2.normalize();
      _dq.setFromAxisAngle(_t2, step);
      v.q.premultiply(_dq).normalize();
    }
    v.angVel.set(0, 0, 0);
  }

  private applyAttitude(h: number, ctrl: Controls): void {
    const v = this.vessel;
    if (!v.hasCapsule()) return; // no control without a capsule
    const hasInput = ctrl.pitch !== 0 || ctrl.yaw !== 0 || ctrl.roll !== 0;
    if (ctrl.pitch !== 0) {
      _t1.set(1, 0, 0).applyQuaternion(v.q);
      v.angVel.addScaledVector(_t1, ctrl.pitch * ANG_ACCEL * h);
    }
    if (ctrl.yaw !== 0) {
      _t1.set(0, 0, 1).applyQuaternion(v.q);
      v.angVel.addScaledVector(_t1, ctrl.yaw * ANG_ACCEL * h);
    }
    if (ctrl.roll !== 0) {
      _t1.set(0, 1, 0).applyQuaternion(v.q);
      v.angVel.addScaledVector(_t1, ctrl.roll * ANG_ACCEL * h);
    }
    if (v.angVel.length() > MAX_ANG_VEL) v.angVel.setLength(MAX_ANG_VEL);
    if (v.sas && !hasInput) {
      v.angVel.multiplyScalar(Math.exp(-4 * h));
      if (v.angVel.lengthSq() < 1e-6) v.angVel.set(0, 0, 0);
    }
    // Integrate orientation: dq/dt = 0.5 * ω * q
    _dq.set(
      v.angVel.x * 0.5 * h,
      v.angVel.y * 0.5 * h,
      v.angVel.z * 0.5 * h,
      0,
    );
    _dq.multiply(v.q);
    v.q.x += _dq.x;
    v.q.y += _dq.y;
    v.q.z += _dq.z;
    v.q.w += _dq.w;
    v.q.normalize();
  }

  private tryLiftoff(frameDt: number, msgs: string[]): void {
    const v = this.vessel;
    const b = v.body;
    if (!v.anyEngineIgnited()) return;
    if (this.warp > 4) this.warp = 4; // engines force physics warp
    frameDt *= this.warp;
    const alt = v.pos.length() - b.radius;
    const pr =
      b.atmosphere && alt < b.atmosphere.height
        ? Math.exp(-Math.max(0, alt) / b.atmosphere.scaleHeight)
        : 0;
    const thrust = v.totalThrust(pr);
    if (v.burn(frameDt, pr)) msgs.push('Flameout — stage out of propellant');
    const g = b.mu / v.pos.lengthSq();
    if (thrust / v.mass() > g) {
      v.landed = false;
      if (v.launchedAt === null) {
        v.launchedAt = this.t;
        msgs.push('Liftoff!');
      }
    }
  }

  /** Keep a landed vessel glued to the rotating surface. */
  syncLanded(): void {
    const v = this.vessel;
    const b = v.body;
    const theta = b.rotationAngle(this.t);
    _up.copy(v.landedDir).applyAxisAngle(_t1.set(0, 1, 0), theta).normalize();
    const standR =
      b.radius + groundHeight(b, v.landedDir) + v.stackHeight() / 2 + 0.6;
    v.pos.copy(_up).multiplyScalar(standR);
    _spin.set(0, b.spinRate, 0);
    v.vel.crossVectors(_spin, v.pos);
    // Orient: local +Y radial, local +Z east (so pitching "W" tips you east).
    _east.crossVectors(_spin, _up);
    if (_east.lengthSq() < 1e-12) _east.set(0, 0, 1);
    _east.normalize();
    _north.crossVectors(_up, _east);
    _mat.makeBasis(_north, _up, _east);
    v.q.setFromRotationMatrix(_mat);
    v.angVel.set(0, 0, 0);
  }

  private checkGround(msgs: string[]): void {
    const v = this.vessel;
    if (v.destroyed || v.landed) return;
    const b = v.body;
    // Terrain is body-fixed: un-rotate the position before sampling height.
    const theta = b.rotationAngle(this.t);
    const dirFixed = _t1
      .copy(v.pos)
      .normalize()
      .applyAxisAngle(_up.set(0, 1, 0), -theta);
    const standR = b.radius + groundHeight(b, dirFixed) + v.stackHeight() / 2;
    if (v.pos.length() > standR) return;

    const water = isWater(b, dirFixed);
    _spin.set(0, b.spinRate, 0);
    _t2.crossVectors(_spin, v.pos);
    const impact = _t3.copy(v.vel).sub(_t2).length();
    v.pos.setLength(standR + 0.6);
    if (impact > SAFE_LANDING_SPEED) {
      v.destroyed = true;
      msgs.push(`CRASH! Impact at ${impact.toFixed(0)} m/s`);
    } else {
      v.landed = true;
      v.throttle = 0;
      v.landedDir.copy(dirFixed);
      this.syncLanded();
      msgs.push(
        water
          ? `Splashdown on ${b.name} at ${impact.toFixed(1)} m/s`
          : `Touchdown on ${b.name} at ${impact.toFixed(1)} m/s`,
      );
    }
  }

  private checkSOI(msgs: string[]): void {
    const v = this.vessel;
    if (v.landed || v.destroyed) return;
    const b = v.body;
    // Escape to parent
    if (b.parent && v.pos.length() > b.soi) {
      b.localPosition(this.t, _t1);
      b.localVelocity(this.t, _t2);
      v.pos.add(_t1);
      v.vel.add(_t2);
      v.body = b.parent;
      msgs.push(`Escaped ${b.name} — now orbiting ${v.body.name}`);
    }
    // Capture by a child
    for (const c of v.body.children) {
      c.localPosition(this.t, _t1);
      if (_t3.copy(v.pos).sub(_t1).length() < c.soi) {
        c.localVelocity(this.t, _t2);
        v.pos.sub(_t1);
        v.vel.sub(_t2);
        v.body = c;
        msgs.push(`Entered ${c.name}'s sphere of influence`);
        break;
      }
    }
  }
}
