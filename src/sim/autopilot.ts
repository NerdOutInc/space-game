import * as THREE from 'three';
import { orbitalElements, timeToApoapsis } from '../math/kepler';
import { Body } from '../universe/bodies';
import type { Vessel } from '../vessel/vessel';
import type { Simulation } from './simulation';

const TWO_PI = Math.PI * 2;

function wrap(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI;
}

/** In-plane longitude of a position (orbits here are prograde/CCW). */
function lambdaOf(p: THREE.Vector3): number {
  return wrap(Math.atan2(-p.z, p.x));
}

const _up = new THREE.Vector3();
const _east = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _hd = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _nose = new THREE.Vector3();

export type ApMode = 'ascent' | 'transfer' | 'rendezvous' | 'dock';

/**
 * MechJeb-lite: flight programs that steer, throttle, stage, and warp.
 * - ascent:     gravity turn to a circular parking orbit
 * - transfer:   Hohmann transfer to a body orbiting your current primary,
 *               including SOI capture into a closed orbit
 * - rendezvous: phased Hohmann to another vessel, then velocity matching
 *               and a proportional approach to 250 m
 * - dock:       rendezvous, then a nose-first port approach until the
 *               magnetic ports capture
 * All Zenith orbits are equatorial/coplanar, which keeps the math honest.
 */
export class Autopilot {
  active = false;
  mode: ApMode = 'ascent';
  phase = 'ascent';
  targetAlt = 100_000; // m, ascent
  targetBody: Body | null = null;
  targetVessel: Vessel | null = null;
  /** World-frame direction the sim should steer the stack toward. */
  desiredDir: THREE.Vector3 | null = null;

  engageAscent(targetAlt: number): string {
    this.active = true;
    this.mode = 'ascent';
    this.phase = 'ascent';
    this.targetAlt = targetAlt;
    return `Autopilot: ascent to ${Math.round(targetAlt / 1000)} km orbit`;
  }

  engageTransfer(vessel: Vessel, body: Body): string {
    if (vessel.landed) return 'Autopilot: launch first, then plan a transfer';
    if (body.parent !== vessel.body)
      return `Autopilot: ${body.name} doesn't orbit ${vessel.body.name} — get into ${body.parent?.name ?? '?'} orbit first`;
    this.active = true;
    this.mode = 'transfer';
    this.phase = 'align';
    this.targetBody = body;
    return `Autopilot: Hohmann transfer to ${body.name} — waiting for the window`;
  }

  engageRendezvous(vessel: Vessel, target: Vessel, dock = false): string {
    if (vessel.landed) return 'Autopilot: launch first';
    if (target.body !== vessel.body)
      return `Autopilot: ${target.name} is in a different sphere of influence`;
    if (dock && (!vessel.hasFreeDock() || !target.hasFreeDock()))
      return 'Autopilot: docking needs a free D-1 port on TOP of both vessels';
    this.active = true;
    this.mode = dock ? 'dock' : 'rendezvous';
    this.phase = 'align';
    this.targetVessel = target;
    return dock
      ? `Autopilot: rendezvous & dock with ${target.name}`
      : `Autopilot: rendezvous with ${target.name}`;
  }

  disengage(): string {
    this.active = false;
    this.desiredDir = null;
    return 'Autopilot disengaged — you have the controls';
  }

  /** Called once per frame from Simulation.step, before physics. */
  update(sim: Simulation): string[] {
    const msgs: string[] = [];
    const v = sim.vessel;
    if (v.destroyed) {
      this.active = false;
      this.desiredDir = null;
      return msgs;
    }

    // ---- shared staging housekeeping (any mode, in flight, under throttle)
    if (!v.landed) {
      const alt = v.pos.length() - v.body.radius;
      const atmo = v.body.atmosphere;
      const pr =
        atmo && alt < atmo.height ? Math.exp(-Math.max(0, alt) / atmo.scaleHeight) : 0;
      // A program that wants thrust lights the engines itself.
      if (v.throttle > 0.02 && !v.anyEngineIgnited()) {
        msgs.push(`Autopilot: ${v.stage().msg}`);
      }
      // Fire a booster-jettison stage as soon as the strap-ons burn dry —
      // but only when that IS the next stage (respect the user's ordering).
      const next = v.stageQueue[0];
      if (
        v.hasSpentBoosters() &&
        next?.every((a) => a.kind === 'jettison') &&
        v.firingEngines(pr).length > 0
      ) {
        const res = v.stage();
        msgs.push(`Autopilot: ${res.msg}`);
        if (res.droppedRadials) sim.droppedRadials.push(res.droppedRadials);
      }
      if (v.throttle > 0.02 && v.anyEngineIgnited() && v.firingEngines(pr).length === 0) {
        if (v.stageQueue.length > 0) {
          const res = v.stage();
          msgs.push(`Autopilot: ${res.msg}`);
          if (res.dropped) sim.dropped.push(res.dropped);
          if (res.droppedRadials) sim.droppedRadials.push(res.droppedRadials);
        } else {
          v.throttle = 0;
          msgs.push('Autopilot: out of propellant — disengaged');
          this.active = false;
          this.desiredDir = null;
          return msgs;
        }
      }
    }

    switch (this.mode) {
      case 'ascent':
        this.updateAscent(sim, msgs);
        break;
      case 'transfer':
        this.updateTransfer(sim, msgs);
        break;
      case 'rendezvous':
      case 'dock':
        this.updateRendezvous(sim, msgs);
        break;
    }
    return msgs;
  }

  /** True when the nose is settled on the commanded direction. */
  private aligned(v: Vessel): boolean {
    if (!this.desiredDir) return true;
    return _nose.set(0, 1, 0).applyQuaternion(v.q).dot(this.desiredDir) > 0.85;
  }

  /**
   * Proximity controller with STABLE pointing targets (so the nose can
   * actually settle): manage closing speed along the line to `goal`, and
   * separately null lateral drift.
   */
  private steerApproach(
    v: Vessel,
    goal: THREE.Vector3, // consumed
    relV: THREE.Vector3,
    cs: number, // wanted closing speed, m/s
    latTol: number,
  ): void {
    const to = goal.sub(v.pos);
    const d = Math.max(to.length(), 1e-6);
    to.divideScalar(d);
    const closing = relV.dot(to);
    const lat = _hd.copy(relV).addScaledVector(to, -closing);
    const latMag = lat.length();

    if (closing > cs + Math.max(1, cs * 0.35)) {
      // too fast — brake
      this.desiredDir = to.clone().multiplyScalar(-1);
      v.throttle = this.aligned(v)
        ? THREE.MathUtils.clamp((closing - cs) / 10, 0.1, 1)
        : 0;
    } else if (closing < cs - Math.max(0.4, cs * 0.15)) {
      // too slow — push toward the goal
      this.desiredDir = to.clone();
      v.throttle = this.aligned(v)
        ? THREE.MathUtils.clamp((cs - closing) / 10, 0.08, 0.8)
        : 0;
    } else if (latMag > latTol) {
      // drifting sideways — null it
      this.desiredDir = lat.clone().divideScalar(-latMag);
      v.throttle = this.aligned(v)
        ? THREE.MathUtils.clamp(latMag / 8, 0.06, 0.6)
        : 0;
    } else {
      v.throttle = 0;
    }
  }

  // ---------------- ascent ----------------

  private updateAscent(sim: Simulation, msgs: string[]): void {
    const v = sim.vessel;
    const b = v.body;
    const r = v.pos.length();
    const alt = r - b.radius;
    const up = _up.copy(v.pos).normalize();
    _spin.set(0, b.spinRate, 0);
    const east = _east.crossVectors(_spin, up);
    if (east.lengthSq() < 1e-12) east.set(0, 0, 1);
    east.normalize();
    const atmo = b.atmosphere;

    // Pad: ignite and hold vertical until we're moving.
    if (v.landed) {
      this.phase = 'ascent';
      if (!v.anyEngineIgnited()) {
        msgs.push(`Autopilot: ${v.stage().msg}`);
      }
      v.throttle = 1;
      if (sim.warp > 4) sim.warp = 4;
      this.desiredDir = up.clone();
      return;
    }

    const el = orbitalElements(v.pos, v.vel, b.mu);
    const apAlt = (el.e < 1 && !el.degenerate ? el.apR : Infinity) - b.radius;
    const atmoTop = (atmo?.height ?? 2000) + 3000;

    switch (this.phase) {
      case 'ascent': {
        if (sim.warp > 4) sim.warp = 4;
        v.throttle = 1;
        // Gravity turn: vertical to ~1 km, then pitch east, ~88° by 45 km.
        const f = THREE.MathUtils.clamp((alt - 1000) / 44000, 0, 1);
        const tilt = THREE.MathUtils.degToRad(88 * Math.pow(f, 0.65));
        this.desiredDir = up
          .clone()
          .multiplyScalar(Math.cos(tilt))
          .addScaledVector(east, Math.sin(tilt));
        if (apAlt >= this.targetAlt) {
          v.throttle = 0;
          this.phase = 'coast';
          msgs.push('Autopilot: apoapsis set — coasting');
        }
        break;
      }
      case 'coast': {
        v.throttle = 0;
        // Track horizontal prograde so we're aligned for the burn.
        _hd.copy(v.vel).addScaledVector(up, -v.vel.dot(up));
        if (_hd.lengthSq() > 1) this.desiredDir = _hd.clone().normalize();
        // Time the burn like a pilot: start half the burn before apoapsis.
        const tAp = timeToApoapsis(v.pos, v.vel, b.mu);
        const burnT = this.circBurnTime(v, el.apR, el.semiLatus, b.mu);
        if (tAp === null || tAp <= burnT / 2 + 2) {
          if (sim.warp > 1) sim.warp = 1;
          this.phase = 'circ';
          msgs.push(
            `Autopilot: circularization burn (${Math.max(1, Math.round(burnT))} s)`,
          );
        } else if (alt > atmoTop) {
          const margin = tAp - burnT / 2;
          const desired = margin > 120 ? 50 : margin > 25 ? 10 : 1;
          if (sim.warp !== desired) sim.warp = desired;
        }
        break;
      }
      case 'circ': {
        if (sim.warp > 4) sim.warp = 1;
        // Thrust prograde-horizontal, pitched slightly to null the radial
        // velocity — this holds altitude near Ap while periapsis rises,
        // which is what actually makes the orbit round.
        _hd.copy(v.vel).addScaledVector(up, -v.vel.dot(up)).normalize();
        const vr = v.vel.dot(up);
        const pitchComp = THREE.MathUtils.clamp(-vr / 100, -0.35, 0.35);
        this.desiredDir = _hd.clone().addScaledVector(up, pitchComp).normalize();
        // Ease the throttle as periapsis closes on the target.
        const peAlt = el.degenerate ? -Infinity : el.peR - b.radius;
        const peErr = this.targetAlt * 0.97 - peAlt;
        v.throttle = THREE.MathUtils.clamp(peErr / 20_000, 0.05, 1);
        if (peErr <= 0 || apAlt > this.targetAlt * 1.6) {
          v.throttle = 0;
          this.active = false;
          this.desiredDir = null;
          msgs.push('Autopilot: orbit complete — you have the controls 🛰');
        }
        break;
      }
    }
  }

  // ---------------- Hohmann transfer to a body ----------------

  private updateTransfer(sim: Simulation, msgs: string[]): void {
    const v = sim.vessel;
    const tgt = this.targetBody;
    if (!tgt) {
      this.active = false;
      return;
    }

    // Arrived in the target's SOI → capture.
    if (v.body === tgt) {
      if (this.phase !== 'capture' && this.phase !== 'correct') {
        this.phase = 'capture';
        if (sim.warp > 10) sim.warp = 10;
        msgs.push(`Autopilot: in ${tgt.name}'s SOI — capture burn at periapsis`);
      }
      this.updateCapture(sim, msgs, tgt);
      return;
    }
    if (tgt.parent !== v.body) {
      msgs.push('Autopilot: left the transfer corridor — disengaged');
      msgs.push(this.disengage());
      return;
    }

    const mu = v.body.mu;
    const r1 = v.pos.length();
    const r2 = tgt.orbitRadius;
    const outward = r2 > r1;

    switch (this.phase) {
      case 'align': {
        v.throttle = 0;
        const el = orbitalElements(v.pos, v.vel, mu);
        if (el.degenerate || el.e > 0.2) {
          msgs.push('Autopilot: circularize first (e < 0.2) — disengaged');
          msgs.push(this.disengage());
          return;
        }
        // Hold prograde while we wait for the phase window.
        this.desiredDir = v.vel.clone().normalize();
        const w1 = Math.sqrt(mu / (r1 * r1 * r1));
        const w2 = TWO_PI / tgt.orbitPeriod;
        const tH = Math.PI * Math.sqrt(Math.pow((r1 + r2) / 2, 3) / mu);
        const phiReq = wrap(Math.PI - w2 * tH);
        const phi = wrap(tgt.orbitAngle(sim.t) - lambdaOf(v.pos));
        const rate = w1 - w2;
        const delta = wrap(phi - phiReq);
        const tWait = rate > 0 ? delta / rate : (delta - TWO_PI) / rate;
        if (tWait < 4) {
          sim.warp = 1;
          this.phase = 'burn';
          msgs.push('Autopilot: transfer window — burning');
        } else {
          const desired = tWait > 2000 ? 100 : tWait > 240 ? 50 : tWait > 30 ? 10 : 1;
          if (sim.warp !== desired) sim.warp = desired;
        }
        break;
      }
      case 'burn': {
        if (sim.warp > 4) sim.warp = 1;
        const el = orbitalElements(v.pos, v.vel, mu);
        this.desiredDir = v.vel.clone().normalize();
        if (!outward) this.desiredDir.multiplyScalar(-1);
        const err = outward ? r2 - el.apR : el.peR - r2;
        if (err <= 0) {
          v.throttle = 0;
          this.phase = 'coast';
          msgs.push(`Autopilot: on the way to ${tgt.name} — coasting`);
        } else {
          v.throttle = this.aligned(v)
            ? THREE.MathUtils.clamp(err / (0.06 * r2), 0.08, 1)
            : 0;
        }
        break;
      }
      case 'coast': {
        v.throttle = 0;
        const vr = v.pos.dot(v.vel) / r1;
        // Missed the SOI: we're heading back without a body switch.
        if ((outward && vr < -1) || (!outward && vr > 1)) {
          this.phase = 'align';
          msgs.push('Autopilot: missed the intercept — replanning');
          break;
        }
        tgt.localPosition(sim.t, _aim);
        const dist = _aim.distanceTo(v.pos);
        const desired = dist > tgt.soi * 4 ? 1000 : dist > tgt.soi * 1.5 ? 100 : 50;
        if (sim.warp !== desired) sim.warp = desired;
        break;
      }
    }
  }

  /** Retro burn at periapsis until we're in a closed orbit inside the SOI. */
  private updateCapture(sim: Simulation, msgs: string[], tgt: Body): void {
    const v = sim.vessel;
    const r = v.pos.length();
    const vr = v.pos.dot(v.vel) / r;
    const el = orbitalElements(v.pos, v.vel, tgt.mu);
    const clearance = tgt.atmosphere
      ? tgt.atmosphere.height + 10_000
      : tgt.maxTerrain + 15_000;

    // Mid-course correction: if the incoming periapsis is underground/too
    // low, burn tangentially (adds angular momentum) until it's safe.
    if (vr < 0 && (el.degenerate || el.peR < tgt.radius + clearance)) {
      sim.warp = 1;
      const rhat = _up.copy(v.pos).divideScalar(r);
      _hd.copy(v.vel).addScaledVector(rhat, -v.vel.dot(rhat));
      if (_hd.lengthSq() < 1) _hd.crossVectors(_east.set(0, 1, 0), rhat);
      this.desiredDir = _hd.clone().normalize();
      if (this.phase !== 'correct') {
        this.phase = 'correct';
        msgs.push('Autopilot: raising periapsis to a safe altitude');
      }
      v.throttle = this.aligned(v) ? 1 : 0;
      return;
    }
    if (this.phase === 'correct') {
      this.phase = 'capture';
      v.throttle = 0;
      msgs.push('Autopilot: periapsis safe — coasting to capture burn');
    }
    this.desiredDir = v.vel.clone().normalize().multiplyScalar(-1);

    if (vr < 0) {
      // still falling toward periapsis
      v.throttle = 0;
      const desired = r > tgt.soi * 0.5 ? 50 : 10;
      if (sim.warp !== desired) sim.warp = desired;
      return;
    }
    if (sim.warp > 1) sim.warp = 1;
    if (el.e < 1 && isFinite(el.apR) && el.apR < tgt.soi * 0.5) {
      v.throttle = 0;
      this.active = false;
      this.desiredDir = null;
      msgs.push(`Autopilot: captured at ${tgt.name}! Orbit is yours 🛰`);
      return;
    }
    v.throttle = this.aligned(v) ? 1 : 0;
  }

  // ---------------- rendezvous / docking ----------------

  private updateRendezvous(sim: Simulation, msgs: string[]): void {
    const v = sim.vessel;
    const tv = this.targetVessel;
    if (!tv || tv.destroyed || !sim.state.vessels.includes(tv)) {
      msgs.push('Autopilot: target lost — disengaged');
      msgs.push(this.disengage());
      return;
    }
    if (tv.body !== v.body) {
      msgs.push('Autopilot: target left this SOI — disengaged');
      msgs.push(this.disengage());
      return;
    }
    const mu = v.body.mu;
    const r1 = v.pos.length();
    const r2 = tv.pos.length();
    const dist = v.pos.distanceTo(tv.pos);
    const relV = _rel.copy(v.vel).sub(tv.vel);

    switch (this.phase) {
      case 'align': {
        v.throttle = 0;
        const el = orbitalElements(v.pos, v.vel, mu);
        if (el.degenerate || el.e > 0.2) {
          msgs.push('Autopilot: circularize first (e < 0.2) — disengaged');
          msgs.push(this.disengage());
          return;
        }
        if (Math.abs(r2 - r1) < 0.03 * r2) {
          if (dist < 30_000) {
            this.phase = 'match';
            sim.warp = 1;
            msgs.push('Autopilot: target close — matching velocity');
            break;
          }
          msgs.push(
            'Autopilot: orbits too similar to phase — change your altitude ~20 km and re-engage',
          );
          msgs.push(this.disengage());
          return;
        }
        this.desiredDir = v.vel.clone().normalize();
        const w1 = Math.sqrt(mu / (r1 * r1 * r1));
        const w2 = Math.sqrt(mu / (r2 * r2 * r2));
        const tH = Math.PI * Math.sqrt(Math.pow((r1 + r2) / 2, 3) / mu);
        const phiReq = wrap(Math.PI - w2 * tH);
        const phi = wrap(lambdaOf(tv.pos) - lambdaOf(v.pos));
        const rate = w1 - w2;
        const delta = wrap(phi - phiReq);
        const tWait = rate > 0 ? delta / rate : (delta - TWO_PI) / rate;
        if (tWait < 4) {
          sim.warp = 1;
          this.phase = 'burn';
          msgs.push('Autopilot: intercept window — burning');
        } else {
          const desired = tWait > 2000 ? 100 : tWait > 240 ? 50 : tWait > 30 ? 10 : 1;
          if (sim.warp !== desired) sim.warp = desired;
        }
        break;
      }
      case 'burn': {
        if (sim.warp > 4) sim.warp = 1;
        const el = orbitalElements(v.pos, v.vel, mu);
        const outward = r2 > r1;
        this.desiredDir = v.vel.clone().normalize();
        if (!outward) this.desiredDir.multiplyScalar(-1);
        const err = outward ? r2 - el.apR : el.peR - r2;
        if (err <= 0) {
          v.throttle = 0;
          this.phase = 'coast';
          msgs.push('Autopilot: intercept set — coasting');
        } else {
          v.throttle = this.aligned(v)
            ? THREE.MathUtils.clamp(err / (0.06 * r2), 0.08, 1)
            : 0;
        }
        break;
      }
      case 'coast': {
        v.throttle = 0;
        if (dist < 25_000) {
          sim.warp = 1;
          this.phase = 'match';
          msgs.push('Autopilot: terminal phase — matching velocity');
          break;
        }
        const vr = v.pos.dot(v.vel) / r1;
        const outward = r2 > r1;
        if ((outward && vr < -1) || (!outward && vr > 1)) {
          this.phase = 'align';
          msgs.push('Autopilot: missed the intercept — replanning');
          break;
        }
        const desired = dist > 2_000_000 ? 100 : dist > 300_000 ? 50 : 10;
        if (sim.warp !== desired) sim.warp = desired;
        break;
      }
      case 'match': {
        if (sim.warp > 1) sim.warp = 1;
        const speed = relV.length();
        if (speed < 2) {
          this.phase = 'approach';
          break;
        }
        this.desiredDir = relV.clone().multiplyScalar(-1 / speed);
        v.throttle = this.aligned(v)
          ? THREE.MathUtils.clamp(speed / 20, 0.1, 1)
          : 0;
        break;
      }
      case 'approach': {
        if (sim.warp > 1) sim.warp = 1;
        if (dist < 250 && relV.length() < 3) {
          if (this.mode === 'dock') {
            this.phase = 'dockapproach';
            msgs.push('Autopilot: final approach — ports aligned, magnets hot');
          } else {
            v.throttle = 0;
            this.active = false;
            this.desiredDir = null;
            msgs.push('Autopilot: rendezvous complete — holding ~250 m off target');
          }
          break;
        }
        const cs = THREE.MathUtils.clamp(dist / 50, 1.5, 45);
        this.steerApproach(v, _aim.copy(tv.pos), relV, cs, 1.0);
        break;
      }
      case 'dockapproach': {
        if (sim.warp > 1) sim.warp = 1;
        if (v.dockedWith) {
          v.throttle = 0;
          this.active = false;
          this.desiredDir = null;
          msgs.push('Autopilot: hard dock — program complete');
          break;
        }
        if (dist > 400) {
          this.phase = 'approach';
          break;
        }
        const upB = _up.set(0, 1, 0).applyQuaternion(tv.q);
        const port = _aim
          .copy(tv.pos)
          .addScaledVector(upB, tv.stackHeight() / 2);
        const dp = v.pos.distanceTo(port);
        // Close enough: hand over to the magnetic port (it pulls and aligns
        // on its own — our steering would only fight it).
        if (dp < 6 && relV.length() < 1.2) {
          v.throttle = 0;
          this.desiredDir = null;
          break;
        }
        // aim slightly outside the port along its axis, closing as we near
        const standoff = THREE.MathUtils.clamp(dp * 0.4, 1.5, 10);
        port.addScaledVector(upB, standoff);
        const cs = THREE.MathUtils.clamp(dp / 15, 0.6, 5);
        this.steerApproach(v, port, relV, cs, 0.4);
        break;
      }
    }
  }

  /** Estimated seconds of full-throttle burn to circularize at apoapsis. */
  private circBurnTime(v: Vessel, apR: number, semiLatus: number, mu: number): number {
    let thrust = 0;
    for (const p of [...v.parts, ...v.radials]) {
      if ((p.def.type === 'engine' || p.def.type === 'srb') && p.ignited) {
        thrust += p.def.thrust ?? 0;
      }
    }
    if (thrust <= 0 || !isFinite(apR)) return 0;
    const h = Math.sqrt(semiLatus * mu); // specific angular momentum
    const vAtAp = h / apR;
    const dv = Math.max(0, Math.sqrt(mu / apR) - vAtAp);
    return dv / (thrust / v.mass());
  }
}
