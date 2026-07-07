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

// ---- aero-thermal tuning ----
const HEAT_K = 2e-6; // skin heating ~ K * rho * v^3  (K/s)
const HEAT_COOL = 0.15; // 1/s decay toward ambient
const AMBIENT_K = 260;
const TEMP_TOL = 1100; // K — ordinary parts start burning off
const TEMP_TOL_SHIELD = 2600; // K — when a heat shield takes the airflow
const SHIELD_FACTOR = 0.12; // heating multiplier behind a leading shield
const CHUTE_RIP_Q = 18_000; // Pa — deployed canopies tear above this
const CHUTE_SAFE_Q = 12_000; // Pa — armed chutes wait for less than this
const CHUTE_SAFE_V = 320; // m/s — ...and subsonic-ish airspeed

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
  readonly state: GameState;

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

  /**
   * Magnetic docking pass. MUST run after inactive vessels have been
   * advanced to the same universal time as the active vessel — inside
   * step() the two would be one frame of orbital motion (~100 m!) apart.
   */
  dockingPass(dt: number): string[] {
    const msgs: string[] = [];
    this.updateDocking(dt, msgs);
    if (this.vessel.dockedWith) this.vessel.dockedWith.followDockPartner();
    return msgs;
  }

  private dockCooldownUntil = 0;

  /** Magnetic docking: attract, align, and capture nearby free ports. */
  private updateDocking(dt: number, msgs: string[]): void {
    const v = this.vessel;
    if (this.t < this.dockCooldownUntil) return;
    if (v.landed || v.destroyed || v.dockedWith || !v.hasFreeDock()) return;
    const upA = _t1.set(0, 1, 0).applyQuaternion(v.q);
    for (const o of this.state.vessels) {
      if (
        o === v ||
        o.destroyed ||
        o.landed ||
        o.body !== v.body ||
        !o.hasFreeDock()
      ) {
        continue;
      }
      const upB = _t2.set(0, 1, 0).applyQuaternion(o.q);
      // port positions (ports sit on top of each stack)
      const pA = _t3.copy(v.pos).addScaledVector(upA, v.stackHeight() / 2);
      const pB = _up.copy(o.pos).addScaledVector(upB, o.stackHeight() / 2);
      const d = pA.distanceTo(pB);
      if (d > 15) continue;
      const vRel = _east.copy(v.vel).sub(o.vel).length();
      if (vRel > 4) continue;
      // evaluate everything BEFORE steering (steerToward reuses scratch vecs)
      const align = upA.dot(upB);
      const capture = d < 2.6 && vRel < 1.5 && align < -0.4;

      // magnetic pull on the active vessel (stronger as the gap closes)
      const dir = pB.sub(pA).normalize(); // NB: reuses _up storage
      const pull = d < 4 ? 1.2 : Math.min(0.5, (15 - d) * 0.06);
      v.vel.addScaledVector(dir, pull * dt);
      // ...and damping, so the pair settles instead of swinging past
      if (d < 8) {
        _t3.copy(v.vel).sub(o.vel);
        v.vel.addScaledVector(_t3, -Math.min(0.4, dt * 0.5));
      }
      // alignment torque once close: our port turns to face theirs
      if (!capture && d < 12) {
        const want = _north.copy(upB).multiplyScalar(-1);
        this.steerToward(Math.min(dt, 0.1) * 2.5, want);
      }
      if (capture) {
        v.dockedWith = o;
        o.dockedWith = v;
        // snap the pair together, ports touching
        v.computeDockLink();
        o.q.copy(v.q);
        o.q.multiply(_dq.setFromAxisAngle(_east.set(1, 0, 0), Math.PI));
        v.computeDockLink();
        v.dockedWith.followDockPartner();
        o.computeDockLink();
        this.warp = 1;
        msgs.push('Docking confirmed! 🧲  (U to undock)');
      }
      return; // only consider the nearest candidate per frame
    }
  }

  /** Separate a docked pair with a gentle push. */
  undock(): string | null {
    const v = this.vessel;
    const o = v.dockedWith;
    if (!o) return null;
    v.dockedWith = null;
    o.dockedWith = null;
    this.dockCooldownUntil = this.t + 60; // let the pair drift clear
    _t1.set(0, 1, 0).applyQuaternion(v.q);
    o.vel.addScaledVector(_t1, 0.8);
    v.vel.addScaledVector(_t1, -0.2);
    return 'Undocked';
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

    const m = v.mass() + (v.dockedWith?.mass() ?? 0);

    // Thrust along the stack's local +Y
    const thrust = v.totalThrust(pressureRatio);
    if (thrust > 0) {
      _t1.set(0, 1, 0).applyQuaternion(v.q);
      _acc.addScaledVector(_t1, thrust / m);
    }
    if (v.anyEngineIgnited() && v.burn(h, pressureRatio)) {
      msgs.push('Flameout — stage out of propellant');
    }

    // Drag (relative to the co-rotating atmosphere) + aero-thermal effects
    if (rho > 0) {
      _spin.set(0, b.spinRate, 0);
      _t2.crossVectors(_spin, v.pos); // atmosphere velocity
      _t3.copy(v.vel).sub(_t2); // airspeed
      const va = _t3.length();
      if (va > 0.1) {
        _acc.addScaledVector(_t3, (-0.5 * rho * va * v.dragArea()) / m);
        this.aeroThermal(h, rho, va, _t3, alt, msgs);
      }
    }
    // Radiate heat away everywhere (space included)
    v.skinTemp += (AMBIENT_K - v.skinTemp) * Math.min(1, HEAT_COOL * h);

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

  /**
   * Parachute aerodynamics and reentry heating.
   * Heating ~ rho·v³ on the vessel skin; a heat shield on the end facing
   * the airflow absorbs most of it and tolerates far higher temperatures.
   * Sustained overheating burns parts off the leading end.
   */
  private aeroThermal(
    h: number,
    rho: number,
    va: number,
    vAir: THREE.Vector3,
    alt: number,
    msgs: string[],
  ): void {
    const v = this.vessel;
    const qDyn = 0.5 * rho * va * va;
    const descending = v.pos.dot(v.vel) < 0;

    for (const c of v.allChutes()) {
      if (c.deployed) {
        c.inflate = Math.min(1, (c.inflate ?? 1) + h / 2.5);
        if (qDyn > CHUTE_RIP_Q) {
          c.deployed = false;
          c.torn = true;
          msgs.push('Parachute torn away by the airstream!');
        }
      } else if (
        c.armed &&
        descending &&
        alt < 40_000 &&
        qDyn < CHUTE_SAFE_Q &&
        va < CHUTE_SAFE_V
      ) {
        c.deployed = true;
        c.armed = false;
        c.inflate = 0.05;
        msgs.push('Parachute deployed!');
      }
    }

    if (va < 30) return; // negligible heating
    // Which end of the stack meets the airflow?
    const upDot = _up.set(0, 1, 0).applyQuaternion(v.q).dot(vAir) / va;
    const first = v.parts[0];
    const last = v.parts[v.parts.length - 1];
    const shieldLeads =
      (upDot < -0.3 && last?.def.type === 'shield') ||
      (upDot > 0.3 && first?.def.type === 'shield');
    let heat = HEAT_K * rho * va * va * va;
    if (shieldLeads) heat *= SHIELD_FACTOR;
    v.skinTemp += heat * h;

    const tol = shieldLeads ? TEMP_TOL_SHIELD : TEMP_TOL;
    if (v.skinTemp > tol) {
      v.overheatT += h;
      if (v.overheatT > 1.2) {
        v.overheatT = 0;
        const res = v.burnOffLeading(upDot > 0.3);
        if (res) {
          msgs.push(
            res.fatal
              ? `${res.name} overheated — vessel destroyed!`
              : `${res.name} burned up!`,
          );
        }
      }
    } else if (v.overheatT > 0) {
      v.overheatT = Math.max(0, v.overheatT - h);
    }
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
