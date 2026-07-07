import * as THREE from 'three';
import { propagateKepler } from './math/kepler';
import { BODIES, Body, HOME } from './universe/bodies';
import { PartDef, PART_BY_ID } from './vessel/parts';
import { Vessel } from './vessel/vessel';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

const SAVE_KEY = 'zenith-save-v1';

/** Science milestones: earned once per save, spent on part unlocks. */
export const MILESTONE_DEFS: Record<string, { name: string; pts: number }> = {
  alt10k: { name: 'Broke 10 km over Gaia', pts: 10 },
  space: { name: 'Reached space', pts: 20 },
  recover: { name: 'Recovered a spacefaring vessel', pts: 20 },
  'orbit-gaia': { name: 'Stable orbit around Gaia', pts: 40 },
  escape: { name: "Escaped Gaia's influence", pts: 30 },
  'soi-luna': { name: "Entered Luna's sphere of influence", pts: 40 },
  'orbit-luna': { name: 'Stable orbit around Luna', pts: 50 },
  'land-luna': { name: 'Landed on Luna', pts: 100 },
  'soi-ember': { name: "Entered Ember's sphere of influence", pts: 60 },
  'orbit-ember': { name: 'Stable orbit around Ember', pts: 70 },
  'land-ember': { name: 'Landed on Ember', pts: 150 },
  'soi-ares': { name: "Entered Ares' sphere of influence", pts: 60 },
  'orbit-ares': { name: 'Stable orbit around Ares', pts: 70 },
  'land-ares': { name: 'Landed on Ares', pts: 150 },
};

interface SavedPart {
  id: string;
  fuel: number;
  ignited: boolean;
  deployed: boolean;
}

interface SavedVessel {
  name: string;
  body: string;
  pos: number[];
  vel: number[];
  q: number[];
  landedDir: number[];
  landed: boolean;
  destroyed: boolean;
  reachedSpace: boolean;
  launchedAt: number | null;
  throttle: number;
  defs: string[];
  parts: SavedPart[];
}

interface SaveData {
  version: 1;
  t: number;
  counter: number;
  science: number;
  milestones: string[];
  unlocked: string[];
  vessels: SavedVessel[];
}

/**
 * Persistent world state shared by every scene: one universal clock, the
 * roster of all vessels, and career progress (science, milestones, unlocked
 * parts). The active vessel is simulated by the flight scene; everyone else
 * coasts on rails here.
 */
export class GameState {
  /** Universal time, seconds. Never resets. */
  t = 0;
  vessels: Vessel[] = [];
  science = 0;
  milestones = new Set<string>();
  /** Purchased part ids (parts without a cost are always available). */
  unlocked = new Set<string>();
  private counter = 1;
  /** Set after wipeSave() so the pre-reload autosave can't resurrect the save. */
  private wiped = false;

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

  // ---------- science & unlocks ----------

  /** Award a milestone once. Returns a toast message, or null if already earned. */
  award(id: string): string | null {
    const def = MILESTONE_DEFS[id];
    if (!def || this.milestones.has(id)) return null;
    this.milestones.add(id);
    this.science += def.pts;
    this.save();
    return `✦ +${def.pts} science — ${def.name}`;
  }

  isUnlocked(def: PartDef): boolean {
    return !def.cost || this.unlocked.has(def.id);
  }

  /** Spend science to unlock a part. Returns true on success. */
  unlockPart(def: PartDef): boolean {
    if (this.isUnlocked(def)) return true;
    if (!def.cost || this.science < def.cost) return false;
    this.science -= def.cost;
    this.unlocked.add(def.id);
    this.save();
    return true;
  }

  // ---------- background propagation ----------

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

  // ---------- persistence ----------

  hasSave(): boolean {
    return localStorage.getItem(SAVE_KEY) !== null;
  }

  save(): void {
    if (this.wiped) return;
    const data: SaveData = {
      version: 1,
      t: this.t,
      counter: this.counter,
      science: this.science,
      milestones: [...this.milestones],
      unlocked: [...this.unlocked],
      vessels: this.vessels.map((v) => ({
        name: v.name,
        body: v.body.name,
        pos: v.pos.toArray(),
        vel: v.vel.toArray(),
        q: v.q.toArray() as number[],
        landedDir: v.landedDir.toArray(),
        landed: v.landed,
        destroyed: v.destroyed,
        reachedSpace: v.reachedSpace,
        launchedAt: v.launchedAt,
        throttle: v.throttle,
        defs: v.defs.map((d) => d.id),
        parts: v.parts.map((p) => ({
          id: p.def.id,
          fuel: p.fuel,
          ignited: p.ignited,
          deployed: p.deployed,
        })),
      })),
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      // storage full/unavailable — play on without saving
    }
  }

  /** Load the save if present. Returns true when progress was restored. */
  load(): boolean {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw) as SaveData;
      if (data.version !== 1) return false;
      this.t = data.t;
      this.counter = data.counter;
      this.science = data.science;
      this.milestones = new Set(data.milestones);
      this.unlocked = new Set(data.unlocked);
      this.vessels = [];
      for (const sv of data.vessels) {
        const defs = sv.defs.map((id) => PART_BY_ID[id]).filter(Boolean);
        if (defs.length === 0) continue;
        const body = BODIES.find((b) => b.name === sv.body) ?? HOME;
        const v = new Vessel(defs, body);
        v.name = sv.name;
        v.pos.fromArray(sv.pos);
        v.vel.fromArray(sv.vel);
        v.q.fromArray(sv.q);
        v.landedDir.fromArray(sv.landedDir);
        v.landed = sv.landed;
        v.destroyed = sv.destroyed;
        v.reachedSpace = sv.reachedSpace;
        v.launchedAt = sv.launchedAt;
        v.throttle = sv.throttle;
        v.parts = sv.parts
          .filter((p) => PART_BY_ID[p.id])
          .map((p) => ({
            def: PART_BY_ID[p.id],
            fuel: p.fuel,
            ignited: p.ignited,
            deployed: p.deployed,
          }));
        this.vessels.push(v);
      }
      return true;
    } catch {
      return false;
    }
  }

  wipeSave(): void {
    this.wiped = true;
    localStorage.removeItem(SAVE_KEY);
  }
}

export const STATE = new GameState();
