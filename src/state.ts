import * as THREE from 'three';
import { propagateKepler } from './math/kepler';
import { Vessel } from './vessel/vessel';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/**
 * Persistent world state shared by every scene: one universal clock and the
 * roster of all vessels. The active vessel is simulated by the flight scene;
 * everyone else coasts on rails here.
 */
export class GameState {
  /** Universal time, seconds. Never resets. */
  t = 0;
  vessels: Vessel[] = [];
  private counter = 1;

  nextName(): string {
    return `Zenith ${this.counter++}`;
  }

  add(v: Vessel): void {
    this.vessels.push(v);
  }

  remove(v: Vessel): void {
    this.vessels = this.vessels.filter((x) => x !== v);
  }

  replace(oldV: Vessel, newV: Vessel): void {
    this.vessels = this.vessels.map((x) => (x === oldV ? newV : x));
  }

  /**
   * Advance every vessel except `active` by dt seconds of pure two-body
   * coasting (no thrust/drag for unfocused craft), with SOI transitions.
   */
  advanceInactive(dt: number, active: Vessel | null): void {
    if (dt <= 0) return;
    for (const v of this.vessels) {
      if (v === active || v.landed || v.destroyed) continue;
      propagateKepler(v.pos, v.vel, dt, v.body.mu, v.pos, v.vel);

      const b = v.body;
      if (b.parent && v.pos.length() > b.soi) {
        b.localPosition(this.t, _p);
        b.localVelocity(this.t, _v);
        v.pos.add(_p);
        v.vel.add(_v);
        v.body = b.parent;
      }
      for (const c of v.body.children) {
        c.localPosition(this.t, _p);
        if (_w.copy(v.pos).sub(_p).length() < c.soi) {
          c.localVelocity(this.t, _v);
          v.pos.sub(_p);
          v.vel.sub(_v);
          v.body = c;
          break;
        }
      }

      // Unfocused craft that fall below the surface are lost.
      if (v.pos.length() < v.body.radius + v.stackHeight() / 2) {
        v.destroyed = true;
      }
    }
  }
}

export const STATE = new GameState();
