import * as THREE from 'three';
import { propagateKepler } from './math/kepler';
import { BODIES, HOME } from './universe/bodies';
import { BOOSTER_DEF_ID, PartDef, PART_BY_ID } from './vessel/parts';
import { Vessel } from './vessel/vessel';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

const SLOT_PREFIX = 'zenith-slot-';
const LEGACY_KEY = 'zenith-save-v1';

/** Menu-facing summary of one saved game. */
export interface SlotMeta {
  id: string;
  mode: GameMode;
  savedAt: number; // epoch ms
  ut: number; // universal time, s
  science: number;
  vessels: number;
}

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
  dock: { name: 'First docking', pts: 80 },
};

export type GameMode = 'science' | 'freedom';

interface SavedPart {
  id: string;
  fuel: number;
  ignited: boolean;
  deployed: boolean;
  armed?: boolean;
  torn?: boolean;
}

interface SavedBooster {
  hostIndex: number;
  fuel: number;
  ignited: boolean;
}

interface SavedRadialChute {
  hostIndex: number;
  deployed: boolean;
  armed: boolean;
  torn?: boolean;
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
  craft: Array<{ id: string; boosters: number; chutes?: number }>;
  parts: SavedPart[];
  boosters: SavedBooster[];
  radialChutes?: SavedRadialChute[];
  /** Index of the docked partner in the vessels array, or -1. */
  docked?: number;
  /** v1 saves stored the craft as a flat list of part ids. */
  defs?: string[];
}

interface SaveData {
  version: 1 | 2 | 3;
  t: number;
  counter: number;
  science: number;
  milestones: string[];
  unlocked: string[];
  vessels: SavedVessel[];
  mode?: GameMode;
  savedAt?: number;
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
  /** 'science' = career with unlocks; 'freedom' = everything available. */
  mode: GameMode = 'science';
  science = 0;
  milestones = new Set<string>();
  /** Purchased part ids (parts without a cost are always available). */
  unlocked = new Set<string>();
  private counter = 1;
  /** Which save slot this session writes to (created lazily on first save). */
  private activeSlot: string | null = null;

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
    if (this.mode === 'freedom') return true;
    return !def.cost || this.unlocked.has(def.id);
  }

  /** Start a fresh game in the given mode, in a brand-new save slot. */
  reset(mode: GameMode): void {
    this.t = 0;
    this.vessels = [];
    this.mode = mode;
    this.science = 0;
    this.milestones = new Set();
    this.unlocked = new Set();
    this.counter = 1;
    this.activeSlot = `${SLOT_PREFIX}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    this.save();
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
      // Docked partners ride along instead of propagating independently:
      // skip if our partner is the active vessel (the sim syncs us) or an
      // earlier list entry (it propagated this frame; we follow it).
      if (v.dockedWith) {
        if (v.dockedWith === active) continue;
        const partnerIdx = this.vessels.indexOf(v.dockedWith);
        if (partnerIdx !== -1 && partnerIdx < this.vessels.indexOf(v)) {
          v.followDockPartner();
          continue;
        }
      }
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
    return this.listSlots().length > 0;
  }

  /** All saved games, newest first. */
  listSlots(): SlotMeta[] {
    this.migrateLegacy();
    const out: SlotMeta[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(SLOT_PREFIX)) continue;
      try {
        const data = JSON.parse(localStorage.getItem(key)!) as SaveData;
        out.push({
          id: key,
          mode: data.mode ?? 'science',
          savedAt: data.savedAt ?? 0,
          ut: data.t ?? 0,
          science: data.science ?? 0,
          vessels: (data.vessels ?? []).length,
        });
      } catch {
        // unreadable slot — skip it
      }
    }
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  }

  /** One-time move of the old single-save key into the slot system. */
  private migrateLegacy(): void {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as SaveData;
      data.savedAt = data.savedAt ?? Date.now();
      localStorage.setItem(`${SLOT_PREFIX}legacy`, JSON.stringify(data));
    } catch {
      // corrupted legacy save — drop it
    }
    localStorage.removeItem(LEGACY_KEY);
  }

  deleteSlot(id: string): void {
    localStorage.removeItem(id);
    if (this.activeSlot === id) this.activeSlot = null;
  }

  save(): void {
    if (!this.activeSlot) {
      this.activeSlot = `${SLOT_PREFIX}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    }
    const data: SaveData = {
      version: 3,
      t: this.t,
      counter: this.counter,
      science: this.science,
      milestones: [...this.milestones],
      unlocked: [...this.unlocked],
      mode: this.mode,
      savedAt: Date.now(),
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
        craft: v.craft.map((c) => ({
          id: c.def.id,
          boosters: c.boosters,
          chutes: c.chutes,
        })),
        parts: v.parts.map((p) => ({
          id: p.def.id,
          fuel: p.fuel,
          ignited: p.ignited,
          deployed: p.deployed,
          armed: p.armed,
          torn: p.torn,
        })),
        boosters: v.boosters.map((b) => ({
          hostIndex: b.hostIndex,
          fuel: b.fuel,
          ignited: b.ignited,
        })),
        radialChutes: v.radialChutes.map((c) => ({
          hostIndex: c.hostIndex,
          deployed: c.deployed,
          armed: c.armed,
          torn: c.torn,
        })),
        docked: v.dockedWith ? this.vessels.indexOf(v.dockedWith) : -1,
      })),
    };
    try {
      localStorage.setItem(this.activeSlot, JSON.stringify(data));
    } catch {
      // storage full/unavailable — play on without saving
    }
  }

  /** Load the most recently played slot (after legacy migration). */
  loadLatest(): boolean {
    const slots = this.listSlots();
    return slots.length > 0 ? this.loadSlot(slots[0].id) : false;
  }

  /** Load a specific save slot. Returns true when progress was restored. */
  loadSlot(id: string): boolean {
    const raw = localStorage.getItem(id);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw) as SaveData;
      if (data.version !== 1 && data.version !== 2 && data.version !== 3) return false;
      this.t = data.t;
      this.counter = data.counter;
      this.science = data.science;
      this.milestones = new Set(data.milestones);
      this.unlocked = new Set(data.unlocked);
      this.mode = data.mode ?? 'science';
      this.vessels = [];
      const srb = PART_BY_ID[BOOSTER_DEF_ID];
      const chuteDef = PART_BY_ID['parachute'];
      for (const sv of data.vessels) {
        // v1 stored a flat part-id list; v2 stores craft slots with boosters
        const craftIds = sv.craft ?? (sv.defs ?? []).map((id) => ({ id, boosters: 0 }));
        const craft = craftIds
          .filter((c) => PART_BY_ID[c.id])
          .map((c) => ({
            def: PART_BY_ID[c.id],
            boosters: c.boosters ?? 0,
            chutes: c.chutes ?? 0,
          }));
        if (craft.length === 0) continue;
        const body = BODIES.find((b) => b.name === sv.body) ?? HOME;
        const v = new Vessel(craft, body);
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
            armed: p.armed ?? false,
            torn: p.torn ?? false,
          }));
        v.boosters = (sv.boosters ?? []).map((b) => ({
          def: srb,
          fuel: b.fuel,
          ignited: b.ignited,
          deployed: false,
          armed: false,
          hostIndex: b.hostIndex,
        }));
        v.radialChutes = (sv.radialChutes ?? []).map((c) => ({
          def: chuteDef,
          fuel: 0,
          ignited: false,
          deployed: c.deployed,
          armed: c.armed,
          torn: c.torn ?? false,
          hostIndex: c.hostIndex,
        }));
        this.vessels.push(v);
      }
      // Re-link docked pairs now that every vessel exists.
      data.vessels.forEach((sv, i) => {
        const partner = sv.docked ?? -1;
        const a = this.vessels[i];
        const b = this.vessels[partner];
        if (a && b && partner > i) {
          a.dockedWith = b;
          b.dockedWith = a;
          a.computeDockLink();
          b.computeDockLink();
        }
      });
      this.activeSlot = id;
      return true;
    } catch {
      return false;
    }
  }
}

export const STATE = new GameState();
