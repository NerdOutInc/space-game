import * as THREE from 'three';
import { propagateKepler } from './math/kepler';
import { BODIES, HOME } from './universe/bodies';
import { PAD_DIR } from './universe/terrain';
import {
  CraftDesign,
  CraftSlot,
  RadialGroup,
  StageAction,
  defaultStages,
  findByUid,
  nextUid,
} from './vessel/craft';
import { PART_BY_ID, PartDef } from './vessel/parts';
import { PartInstance, RadialInstance, Vessel } from './vessel/vessel';

/**
 * Universal time at which the sun sits ~30° above the launch site's eastern
 * horizon (a bright morning). Sun elevation at the pad is -cos(φ + θ) where
 * φ is the pad's longitude and θ the planet's rotation, so we solve for
 * elevation = 0.5 regardless of where the terrain search put the pad.
 */
function morningTime(): number {
  const phi = Math.atan2(-PAD_DIR.z, PAD_DIR.x);
  const TWO_PI = Math.PI * 2;
  const theta = (((2 * Math.PI) / 3 - phi) % TWO_PI + TWO_PI) % TWO_PI;
  return (theta / TWO_PI) * HOME.rotationPeriod;
}

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

// ---------- save format ----------

interface SavedPart {
  id: string;
  fuel: number;
  mono?: number;
  ignited: boolean;
  deployed: boolean;
  armed?: boolean;
  torn?: boolean;
}

interface SavedRadial extends SavedPart {
  host: number; // stack index
  g: number; // radial-group ordinal (symmetric copies share one)
}

/** Stage action reference: p = stack part index, g = radial-group ordinal. */
interface SavedAction {
  k: StageAction['kind'];
  p?: number;
  g?: number;
}

interface SavedDesign {
  slots: Array<{ id: string; radials?: Array<{ id: string; count: number }> }>;
  /** Refs are (slot index s, radial index r within the slot). */
  stages: Array<Array<{ k: StageAction['kind']; s: number; r?: number }>>;
}

// v1–v3 legacy shapes
interface SavedBoosterV3 {
  hostIndex: number;
  fuel: number;
  ignited: boolean;
}
interface SavedRadialChuteV3 {
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
  rcsOn?: boolean;
  parts: SavedPart[];
  /** Index of the docked partner in the vessels array, or -1. */
  docked?: number;
  // ---- v4 ----
  design?: SavedDesign;
  radials?: SavedRadial[];
  queue?: SavedAction[][];
  // ---- v1–v3 ----
  craft?: Array<{ id: string; boosters: number; chutes?: number }>;
  boosters?: SavedBoosterV3[];
  radialChutes?: SavedRadialChuteV3[];
  defs?: string[];
}

interface SaveData {
  version: 1 | 2 | 3 | 4;
  t: number;
  counter: number;
  science: number;
  milestones: string[];
  unlocked: string[];
  vessels: SavedVessel[];
  mode?: GameMode;
  savedAt?: number;
}

// ---------- design (de)serialization ----------

export function serializeDesign(design: CraftDesign): SavedDesign {
  return {
    slots: design.slots.map((s) => ({
      id: s.def.id,
      radials: s.radials.map((r) => ({ id: r.def.id, count: r.count })),
    })),
    stages: design.stages.map((st) =>
      st.flatMap((a) => {
        const hit = findByUid(design.slots, a.uid);
        if (!hit) return [];
        return hit.radial
          ? [{ k: a.kind, s: hit.index, r: hit.slot.radials.indexOf(hit.radial) }]
          : [{ k: a.kind, s: hit.index }];
      }),
    ),
  };
}

export function deserializeDesign(sd: SavedDesign): CraftDesign {
  const slots: CraftSlot[] = [];
  for (const ss of sd.slots) {
    const def = PART_BY_ID[ss.id];
    if (!def) continue;
    const radials: RadialGroup[] = [];
    for (const sr of ss.radials ?? []) {
      const rdef = PART_BY_ID[sr.id];
      if (rdef) radials.push({ uid: nextUid(), def: rdef, count: sr.count });
    }
    slots.push({ uid: nextUid(), def, radials });
  }
  const stages: StageAction[][] = (sd.stages ?? [])
    .map((st) =>
      st.flatMap((a): StageAction[] => {
        const slot = slots[a.s];
        if (!slot) return [];
        if (a.r != null) {
          const r = slot.radials[a.r];
          return r ? [{ kind: a.k, uid: r.uid }] : [];
        }
        return [{ kind: a.k, uid: slot.uid }];
      }),
    )
    .filter((st) => st.length > 0);
  const design: CraftDesign = { slots, stages };
  if (design.stages.length === 0) design.stages = defaultStages(slots);
  return design;
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
    this.t = morningTime(); // new games open on a sunlit morning at the pad
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
      version: 4,
      t: this.t,
      counter: this.counter,
      science: this.science,
      milestones: [...this.milestones],
      unlocked: [...this.unlocked],
      mode: this.mode,
      savedAt: Date.now(),
      vessels: this.vessels.map((v) => {
        // symmetric radial copies share a groupUid; persist group ordinals
        const groupOrder: number[] = [];
        for (const r of v.radials) {
          if (!groupOrder.includes(r.groupUid)) groupOrder.push(r.groupUid);
        }
        const savePart = (p: PartInstance): SavedPart => ({
          id: p.def.id,
          fuel: p.fuel,
          mono: p.monoprop || undefined,
          ignited: p.ignited,
          deployed: p.deployed,
          armed: p.armed,
          torn: p.torn,
        });
        return {
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
          rcsOn: v.rcsOn,
          design: serializeDesign(v.design),
          parts: v.parts.map(savePart),
          radials: v.radials.map((r) => ({
            ...savePart(r),
            host: r.hostIndex,
            g: groupOrder.indexOf(r.groupUid),
          })),
          queue: v.stageQueue.map((st) =>
            st.flatMap((a): SavedAction[] => {
              const pi = v.parts.findIndex((p) => p.uid === a.uid);
              if (pi >= 0) return [{ k: a.kind, p: pi }];
              const gi = groupOrder.indexOf(a.uid);
              return gi >= 0 ? [{ k: a.kind, g: gi }] : [];
            }),
          ),
          docked: v.dockedWith ? this.vessels.indexOf(v.dockedWith) : -1,
        };
      }),
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
      if (data.version < 1 || data.version > 4) return false;
      this.t = data.t;
      this.counter = data.counter;
      this.science = data.science;
      this.milestones = new Set(data.milestones);
      this.unlocked = new Set(data.unlocked);
      this.mode = data.mode ?? 'science';
      this.vessels = [];
      for (const sv of data.vessels) {
        const v =
          data.version === 4 ? this.loadVesselV4(sv) : this.loadVesselLegacy(sv);
        if (v) this.vessels.push(v);
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

  private restoreCommon(v: Vessel, sv: SavedVessel): void {
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
    v.rcsOn = sv.rcsOn ?? false;
  }

  private loadVesselV4(sv: SavedVessel): Vessel | null {
    if (!sv.design) return null;
    const design = deserializeDesign(sv.design);
    if (design.slots.length === 0) return null;
    const body = BODIES.find((b) => b.name === sv.body) ?? HOME;
    const v = new Vessel(design, body);
    this.restoreCommon(v, sv);

    const mkPart = (sp: SavedPart, def: PartDef): PartInstance => ({
      uid: nextUid(),
      def,
      fuel: sp.fuel,
      monoprop: sp.mono ?? 0,
      ignited: sp.ignited,
      deployed: sp.deployed,
      armed: sp.armed ?? false,
      torn: sp.torn ?? false,
    });
    v.parts = sv.parts
      .filter((p) => PART_BY_ID[p.id])
      .map((p) => mkPart(p, PART_BY_ID[p.id]));
    if (v.parts.length === 0) return null;

    const groupUidByOrdinal = new Map<number, number>();
    v.radials = (sv.radials ?? [])
      .filter((r) => PART_BY_ID[r.id])
      .map((r) => {
        if (!groupUidByOrdinal.has(r.g)) groupUidByOrdinal.set(r.g, nextUid());
        return {
          ...mkPart(r, PART_BY_ID[r.id]),
          hostIndex: r.host,
          groupUid: groupUidByOrdinal.get(r.g)!,
        };
      });
    v.stageQueue = (sv.queue ?? [])
      .map((st) =>
        st.flatMap((a): StageAction[] => {
          if (a.p != null && v.parts[a.p]) {
            return [{ kind: a.k, uid: v.parts[a.p].uid }];
          }
          if (a.g != null && groupUidByOrdinal.has(a.g)) {
            return [{ kind: a.k, uid: groupUidByOrdinal.get(a.g)! }];
          }
          return [];
        }),
      )
      .filter((st) => st.length > 0);
    return v;
  }

  /** v1–v3: counted radial boosters/chutes, implicit heuristic staging. */
  private loadVesselLegacy(sv: SavedVessel): Vessel | null {
    const craftIds =
      sv.craft ?? (sv.defs ?? []).map((id) => ({ id, boosters: 0, chutes: 0 }));
    const slots: CraftSlot[] = [];
    for (const c of craftIds) {
      const def = PART_BY_ID[c.id];
      if (!def) continue;
      const radials: RadialGroup[] = [];
      if (c.boosters) {
        radials.push({ uid: nextUid(), def: PART_BY_ID['srb'], count: c.boosters });
      }
      if (c.chutes) {
        radials.push({
          uid: nextUid(),
          def: PART_BY_ID['parachute'],
          count: c.chutes,
        });
      }
      slots.push({ uid: nextUid(), def, radials });
    }
    if (slots.length === 0) return null;
    const design: CraftDesign = { slots, stages: defaultStages(slots) };
    const body = BODIES.find((b) => b.name === sv.body) ?? HOME;
    const v = new Vessel(design, body);
    this.restoreCommon(v, sv);

    v.parts = sv.parts
      .filter((p) => PART_BY_ID[p.id])
      .map((p) => ({
        uid: nextUid(),
        def: PART_BY_ID[p.id],
        fuel: p.fuel,
        monoprop: 0,
        ignited: p.ignited,
        deployed: p.deployed,
        armed: p.armed ?? false,
        torn: p.torn ?? false,
      }));
    if (v.parts.length === 0) return null;

    // Rebuild live radials, grouping same-host copies into one stage group.
    v.radials = [];
    const srb = PART_BY_ID['srb'];
    const chuteDef = PART_BY_ID['parachute'];
    const boosterGroup = new Map<number, number>();
    for (const b of sv.boosters ?? []) {
      if (!boosterGroup.has(b.hostIndex)) boosterGroup.set(b.hostIndex, nextUid());
      v.radials.push({
        uid: nextUid(),
        def: srb,
        fuel: b.fuel,
        monoprop: 0,
        ignited: b.ignited,
        deployed: false,
        armed: false,
        hostIndex: b.hostIndex,
        groupUid: boosterGroup.get(b.hostIndex)!,
      });
    }
    const chuteGroup = new Map<number, number>();
    for (const c of sv.radialChutes ?? []) {
      if (!chuteGroup.has(c.hostIndex)) chuteGroup.set(c.hostIndex, nextUid());
      v.radials.push({
        uid: nextUid(),
        def: chuteDef,
        fuel: 0,
        monoprop: 0,
        ignited: false,
        deployed: c.deployed,
        armed: c.armed,
        torn: c.torn ?? false,
        hostIndex: c.hostIndex,
        groupUid: chuteGroup.get(c.hostIndex)!,
      });
    }

    // Regenerate a stage queue for the LIVE structure, dropping actions
    // that already happened (lit engines, armed/opened chutes).
    const liveSlots: CraftSlot[] = v.parts.map((p, i) => {
      const radials: RadialGroup[] = [];
      const seen = new Set<number>();
      for (const r of v.radials) {
        if (r.hostIndex === i && !seen.has(r.groupUid)) {
          seen.add(r.groupUid);
          radials.push({
            uid: r.groupUid,
            def: r.def,
            count: v.radials.filter((x) => x.groupUid === r.groupUid).length,
          });
        }
      }
      return { uid: p.uid, def: p.def, radials };
    });
    const stale = (a: StageAction): boolean => {
      const findLive = (uid: number) =>
        v.parts.find((p) => p.uid === uid) ??
        v.radials.find((r) => r.groupUid === uid);
      const t = findLive(a.uid);
      if (!t) return true;
      if (a.kind === 'ignite') return t.ignited;
      if (a.kind === 'chute') return t.armed || t.deployed || !!t.torn;
      return false;
    };
    v.stageQueue = defaultStages(liveSlots)
      .map((st) => st.filter((a) => !stale(a)))
      .filter((st) => st.length > 0);
    return v;
  }
}

export const STATE = new GameState();
