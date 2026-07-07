import * as THREE from 'three';
import { orbitalElements } from '../math/kepler';
import type { Simulation } from './simulation';

const _up = new THREE.Vector3();
const _east = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _hd = new THREE.Vector3();

type Phase = 'ascent' | 'coast' | 'circ';

/**
 * Rudimentary ascent autopilot: ignites on the pad, flies a gravity turn
 * east, auto-stages on flameout, coasts to apoapsis (auto-warping the boring
 * part), and circularizes into a ~100 km orbit. Meant as a worked example of
 * a good ascent profile — watch the tilt/heading it flies and copy it.
 */
export class Autopilot {
  active = false;
  targetAlt = 100_000; // m above the surface
  phase: Phase = 'ascent';
  /** World-frame direction the sim should steer the stack toward. */
  desiredDir: THREE.Vector3 | null = null;

  engage(): string {
    this.active = true;
    this.phase = 'ascent';
    return `Autopilot engaged — flying to a ${Math.round(this.targetAlt / 1000)} km orbit`;
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
    const b = v.body;
    if (v.destroyed) {
      this.active = false;
      this.desiredDir = null;
      return msgs;
    }

    const r = v.pos.length();
    const alt = r - b.radius;
    const up = _up.copy(v.pos).normalize();
    _spin.set(0, b.spinRate, 0);
    const east = _east.crossVectors(_spin, up);
    if (east.lengthSq() < 1e-12) east.set(0, 0, 1);
    east.normalize();
    const atmo = b.atmosphere;
    const pr =
      atmo && alt < atmo.height ? Math.exp(-Math.max(0, alt) / atmo.scaleHeight) : 0;

    // Pad: ignite and hold vertical until we're moving.
    if (v.landed) {
      this.phase = 'ascent';
      if (!v.anyEngineIgnited()) {
        msgs.push(`Autopilot: ${v.stage().msg}`);
      }
      v.throttle = 1;
      if (sim.warp > 4) sim.warp = 4;
      this.desiredDir = up.clone();
      return msgs;
    }

    // Auto-stage when the current stage flames out under throttle.
    if (v.throttle > 0.02 && v.anyEngineIgnited() && v.firingEngines(pr).length === 0) {
      if (v.stageCount() > 1) {
        const res = v.stage();
        msgs.push(`Autopilot: ${res.msg}`);
        if (res.dropped) sim.dropped.push(res.dropped);
      } else {
        v.throttle = 0;
        msgs.push('Autopilot: out of propellant — disengaged');
        this.active = false;
        this.desiredDir = null;
        return msgs;
      }
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
        const toAp = apAlt - alt;
        if (toAp < 8000) {
          if (sim.warp > 1) sim.warp = 1;
          this.phase = 'circ';
          msgs.push('Autopilot: circularization burn');
        } else if (alt > atmoTop) {
          // Warp through the coast, easing off as apoapsis approaches.
          const desired = toAp > 20_000 ? 50 : 10;
          if (sim.warp !== desired && sim.warp < desired) sim.warp = desired;
          if (toAp <= 20_000 && sim.warp > 10) sim.warp = 10;
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
    return msgs;
  }
}
