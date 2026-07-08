import * as THREE from 'three';
import { Body, HOME } from '../universe/bodies';
import { PAD_DIR } from '../universe/terrain';
import { CraftDesign, CraftSlot, StageAction, nextUid } from './craft';
import { G0, PartDef } from './parts';

export interface PartInstance {
  /** Matches the design slot / radial-group uid it was built from. */
  uid: number;
  def: PartDef;
  fuel: number;
  monoprop: number;
  ignited: boolean;
  /** Parachutes: canopy out. Legs: struts extended. */
  deployed: boolean;
  /** Parachutes: staged and waiting for safe atmosphere conditions. */
  armed: boolean;
  /** Parachutes: shredded by dynamic pressure — gone for good. */
  torn?: boolean;
  /** Parachutes: canopy inflation 0..1 (drag ramps up over a few seconds). */
  inflate?: number;
}

/** A radially-attached part, tied to a stack part by index. */
export interface RadialInstance extends PartInstance {
  hostIndex: number;
  /** Shared by all symmetric copies of one design radial group. */
  groupUid: number;
}

export interface StageResult {
  msg: string;
  dropped: PartInstance[] | null;
  droppedRadials: RadialInstance[] | null;
}

interface EngineFiring {
  part: PartInstance;
  thrust: number; // N, after throttle
  mdot: number; // kg/s
}

function newInstance(def: PartDef, uid: number): PartInstance {
  return {
    uid,
    def,
    fuel: def.fuel ?? 0,
    monoprop: def.monoprop ?? 0,
    ignited: false,
    deployed: false,
    armed: false,
  };
}

function cloneDesign(design: CraftDesign): CraftDesign {
  return {
    slots: design.slots.map((s) => ({
      uid: s.uid,
      def: s.def,
      radials: s.radials.map((r) => ({ ...r })),
    })),
    stages: design.stages.map((st) => st.map((a) => ({ ...a }))),
  };
}

const _upTmp = new THREE.Vector3();

export class Vessel {
  parts: PartInstance[]; // stack, ordered top → bottom
  radials: RadialInstance[] = [];
  /** Remaining stage list; stageQueue[0] is the next Space press. */
  stageQueue: StageAction[][];

  /** Docking link: both vessels reference each other while docked. */
  dockedWith: Vessel | null = null;
  /** Partner offset along our +Y and relative orientation, set at capture. */
  dockOffset = 0;
  dockRelQ = new THREE.Quaternion();

  name = 'Untitled Craft';
  /** The original build, kept for "revert to launch". */
  readonly design: CraftDesign;

  body: Body;
  /** Position/velocity relative to `body` center, non-rotating frame. */
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  q = new THREE.Quaternion();
  angVel = new THREE.Vector3(); // world frame, rad/s

  throttle = 1;
  sas = true;
  /** RCS translation enabled (V). */
  rcsOn = false;
  landed = true;
  destroyed = false;
  /** Aero-thermal skin temperature, K (ambient ~290). */
  skinTemp = 290;
  /** Seconds spent above the tolerance — parts burn off when it accumulates. */
  overheatT = 0;
  /** Has this vessel ever left the atmosphere? (drives the recovery bonus) */
  reachedSpace = false;
  /** Surface-fixed unit direction of the landing spot (body frame). */
  landedDir = PAD_DIR.clone();
  launchedAt: number | null = null;

  private hadThrust = false;

  constructor(design: CraftDesign, body: Body = HOME) {
    this.design = cloneDesign(design);
    this.parts = design.slots.map((s) => newInstance(s.def, s.uid));
    design.slots.forEach((s, i) => {
      for (const r of s.radials) {
        for (let k = 0; k < r.count; k++) {
          this.radials.push({
            ...newInstance(r.def, nextUid()),
            hostIndex: i,
            groupUid: r.uid,
          });
        }
      }
    });
    this.stageQueue = design.stages.map((st) => st.map((a) => ({ ...a })));
    this.pruneQueue();
    this.body = body;
  }

  // ---------- structure helpers ----------

  /** Radial SRBs (flame/plume anchors, in radials order). */
  get boosters(): RadialInstance[] {
    return this.radials.filter((r) => r.def.type === 'srb');
  }

  get radialChutes(): RadialInstance[] {
    return this.radials.filter((r) => r.def.type === 'parachute');
  }

  /** All usable parachutes (stack + radial, excluding torn ones). */
  allChutes(): PartInstance[] {
    return [
      ...this.parts.filter((p) => p.def.type === 'parachute'),
      ...this.radialChutes,
    ].filter((p) => !p.torn);
  }

  /** Part groups split by decouplers, ordered top → bottom (decouplers excluded). */
  groups(): PartInstance[][] {
    const gs: PartInstance[][] = [];
    let cur: PartInstance[] = [];
    for (const p of this.parts) {
      if (p.def.type === 'decoupler') {
        gs.push(cur);
        cur = [];
      } else {
        cur.push(p);
      }
    }
    gs.push(cur);
    return gs;
  }

  bottomGroup(): PartInstance[] {
    const gs = this.groups();
    return gs[gs.length - 1];
  }

  /** Decoupler-group ordinal of each stack part (0 = top group). */
  private groupIndexOf(): number[] {
    const out = new Array<number>(this.parts.length);
    let g = 0;
    this.parts.forEach((p, i) => {
      out[i] = g;
      if (p.def.type === 'decoupler') g++;
    });
    return out;
  }

  stageCount(): number {
    return this.stageQueue.length;
  }

  mass(): number {
    let m = 0;
    for (const p of this.parts) m += p.def.dryMass + p.fuel + p.monoprop;
    for (const r of this.radials) m += r.def.dryMass + r.fuel + r.monoprop;
    return m;
  }

  stackHeight(): number {
    let h = 0;
    for (const p of this.parts) h += p.def.height;
    return h;
  }

  hasCapsule(): boolean {
    return this.parts.some((p) => p.def.type === 'capsule');
  }

  hasFreeDock(): boolean {
    return this.parts[0]?.def.type === 'dock' && !this.dockedWith;
  }

  /**
   * Stack-local center height of each part (same convention as the visual:
   * the stack is centered on the origin, bottom at -H/2). Index-aligned
   * with `parts`.
   */
  partCenterYs(): number[] {
    const ys = new Array<number>(this.parts.length);
    let y = -this.stackHeight() / 2;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      ys[i] = y + this.parts[i].def.height / 2;
      y += this.parts[i].def.height;
    }
    return ys;
  }

  /** Mass-weighted center of mass along the stack axis (stack-local y). */
  comY(): number {
    const ys = this.partCenterYs();
    let m = 0;
    let my = 0;
    this.parts.forEach((p, i) => {
      const pm = p.def.dryMass + p.fuel + p.monoprop;
      m += pm;
      my += pm * ys[i];
    });
    for (const r of this.radials) {
      const rm = r.def.dryMass + r.fuel + r.monoprop;
      m += rm;
      my += rm * (ys[r.hostIndex] ?? 0);
    }
    return m > 0 ? my / m : 0;
  }

  /** Moment of inertia about a transverse axis (uniform-rod estimate). */
  momentOfInertia(): number {
    const H = this.stackHeight();
    return Math.max(400, (this.mass() * H * H) / 12);
  }

  /** Cd·A of the hull (everything except deployed canopies). */
  bodyDragArea(): number {
    let a = 1.5;
    for (const r of this.radials) {
      a += r.def.type === 'srb' ? 0.5 : 0.15;
    }
    // a nose cone smooths the stack's leading end
    if (this.parts.some((p) => p.def.type === 'nose')) a -= 0.4;
    return Math.max(0.7, a);
  }

  /**
   * Offset drag surfaces that torque the stack about its CoM: deployed
   * parachute canopies (huge, above their part) and fins (small, constant —
   * mounted low they weathervane the rocket into the airstream).
   */
  dragAnchors(): Array<{ cda: number; y: number }> {
    const ys = this.partCenterYs();
    const out: Array<{ cda: number; y: number }> = [];
    this.parts.forEach((p, i) => {
      if (p.def.type === 'parachute' && p.deployed && !p.torn) {
        out.push({ cda: 380 * (p.inflate ?? 1), y: ys[i] + p.def.height / 2 + 2 });
      }
    });
    for (const r of this.radials) {
      if (r.def.type === 'parachute' && r.deployed && !r.torn) {
        out.push({ cda: 380 * (r.inflate ?? 1), y: (ys[r.hostIndex] ?? 0) + 2 });
      } else if (r.def.type === 'fin') {
        out.push({ cda: r.def.finArea ?? 0.3, y: ys[r.hostIndex] ?? 0 });
      }
    }
    return out;
  }

  // ---------- landing legs & RCS ----------

  legParts(): RadialInstance[] {
    return this.radials.filter((r) => r.def.type === 'legs');
  }

  hasDeployedLegs(): boolean {
    return this.legParts().some((r) => r.deployed);
  }

  /** Toggle all landing legs. Returns the new state, or null without legs. */
  toggleLegs(): boolean | null {
    const legs = this.legParts();
    if (legs.length === 0) return null;
    const next = !legs.some((r) => r.deployed);
    for (const r of legs) r.deployed = next;
    return next;
  }

  /** RCS blocks that still hold monopropellant. */
  rcsBlocks(): RadialInstance[] {
    return this.radials.filter((r) => r.def.type === 'rcs' && r.monoprop > 0);
  }

  rcsThrust(): number {
    return this.rcsBlocks().reduce((s, r) => s + (r.def.rcsThrust ?? 0), 0);
  }

  rcsMonopropFraction(): number {
    let cap = 0;
    let cur = 0;
    for (const r of this.radials) {
      if (r.def.type === 'rcs') {
        cap += r.def.monoprop ?? 0;
        cur += r.monoprop;
      }
    }
    return cap > 0 ? cur / cap : 0;
  }

  consumeMonoprop(kg: number): void {
    const blocks = this.rcsBlocks();
    const total = blocks.reduce((s, r) => s + r.monoprop, 0);
    if (total <= 0) return;
    const ratio = Math.min(1, kg / total);
    for (const r of blocks) r.monoprop -= r.monoprop * ratio;
  }

  // ---------- docking ----------

  /** Recompute the rigid link from current poses (docking / save load). */
  computeDockLink(): void {
    const o = this.dockedWith;
    if (!o) return;
    this.dockOffset = this.stackHeight() / 2 + o.stackHeight() / 2 + 0.1;
    this.dockRelQ.copy(this.q).invert().multiply(o.q);
  }

  /** Snap this vessel to its dock partner's pose (partner is authoritative). */
  followDockPartner(): void {
    const o = this.dockedWith;
    if (!o) return;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(o.q);
    this.pos.copy(o.pos).addScaledVector(up, o.dockOffset);
    this.vel.copy(o.vel);
    this.q.copy(o.q).multiply(o.dockRelQ);
    this.body = o.body;
  }

  // ---------- engines & propellant ----------

  /** Engines currently producing thrust, with per-engine mass flow. */
  firingEngines(pressureRatio: number): EngineFiring[] {
    const gIdx = this.groupIndexOf();
    const groupFuel = new Map<number, number>();
    this.parts.forEach((p, i) => {
      if (p.def.type === 'tank') {
        groupFuel.set(gIdx[i], (groupFuel.get(gIdx[i]) ?? 0) + p.fuel);
      }
    });
    const out: EngineFiring[] = [];
    const consider = (p: PartInstance, avail: number) => {
      if (!p.ignited) return;
      const lvl = p.def.throttleable === false ? 1 : this.throttle;
      if (lvl <= 1e-3 || avail <= 0) return;
      const isp = p.def.ispVac! + (p.def.ispAtm! - p.def.ispVac!) * pressureRatio;
      const thrust = p.def.thrust! * lvl;
      out.push({ part: p, thrust, mdot: thrust / (isp * G0) });
    };
    this.parts.forEach((p, i) => {
      if (p.def.type === 'engine') consider(p, groupFuel.get(gIdx[i]) ?? 0);
      else if (p.def.type === 'srb') consider(p, p.fuel);
    });
    for (const r of this.radials) {
      if (r.def.type === 'srb') consider(r, r.fuel); // own fuel
    }
    return out;
  }

  totalThrust(pressureRatio: number): number {
    return this.firingEngines(pressureRatio).reduce((s, e) => s + e.thrust, 0);
  }

  /** Consume propellant for dt seconds. Returns true if a flameout just occurred. */
  burn(dt: number, pressureRatio: number): boolean {
    const firing = this.firingEngines(pressureRatio);
    if (firing.length > 0) this.hadThrust = true;

    const gIdx = this.groupIndexOf();
    const engineGroup = new Map<PartInstance, number>();
    this.parts.forEach((p, i) => {
      if (p.def.type === 'engine') engineGroup.set(p, gIdx[i]);
    });
    const demand = new Map<number, number>(); // group → kg wanted
    for (const f of firing) {
      if (f.part.def.type === 'srb') {
        f.part.fuel = Math.max(0, f.part.fuel - f.mdot * dt);
      } else {
        const g = engineGroup.get(f.part) ?? 0;
        demand.set(g, (demand.get(g) ?? 0) + f.mdot * dt);
      }
    }
    for (const [g, want] of demand) {
      const tanks: PartInstance[] = [];
      this.parts.forEach((p, i) => {
        if (p.def.type === 'tank' && gIdx[i] === g) tanks.push(p);
      });
      const total = tanks.reduce((s, t) => s + t.fuel, 0);
      if (total <= 0) continue;
      const ratio = Math.min(want, total) / total;
      for (const t of tanks) t.fuel -= t.fuel * ratio;
    }

    // Flameout: we were thrusting, engines remain lit, but nothing can fire now.
    if (this.hadThrust && this.anyEngineIgnited() && this.throttle > 1e-3) {
      const canFire = this.firingEngines(pressureRatio).length > 0;
      if (!canFire) {
        this.hadThrust = false;
        return true;
      }
    }
    return false;
  }

  anyEngineIgnited(): boolean {
    return (
      this.parts.some(
        (p) => (p.def.type === 'engine' || p.def.type === 'srb') && p.ignited,
      ) || this.radials.some((r) => r.def.type === 'srb' && r.ignited)
    );
  }

  /** Ignited side boosters that have burned dry (ready to jettison). */
  hasSpentBoosters(): boolean {
    const bs = this.boosters;
    return (
      bs.length > 0 &&
      bs.every((b) => !b.ignited || b.fuel <= 0) &&
      bs.some((b) => b.ignited && b.fuel <= 0)
    );
  }

  /** Fuel fraction feeding the currently ignited engines (HUD gauge). */
  stageFuelFraction(): number {
    const gIdx = this.groupIndexOf();
    const activeGroups = new Set<number>();
    let cap = 0;
    let cur = 0;
    this.parts.forEach((p, i) => {
      if (p.def.type === 'engine' && p.ignited) activeGroups.add(gIdx[i]);
      if (p.def.type === 'srb' && p.ignited) {
        cap += p.def.fuel ?? 0;
        cur += p.fuel;
      }
    });
    if (activeGroups.size === 0 && cap === 0) {
      // nothing lit yet: show the bottom group so the pad gauge reads full
      activeGroups.add(Math.max(0, ...gIdx));
    }
    this.parts.forEach((p, i) => {
      if (p.def.type === 'tank' && activeGroups.has(gIdx[i])) {
        cap += p.def.fuel ?? 0;
        cur += p.fuel;
      }
    });
    for (const b of this.boosters) {
      if (b.ignited && b.fuel > 0) {
        cap += b.def.fuel ?? 0;
        cur += b.fuel;
      }
    }
    return cap > 0 ? cur / cap : 0;
  }

  // ---------- staging (executes the editable stage list literally) ----------

  /** Resolve a stage action against the LIVE vessel. */
  private resolveAction(a: StageAction): {
    stackPart: PartInstance | null;
    stackIndex: number;
    groupInstances: RadialInstance[];
  } {
    const stackIndex = this.parts.findIndex((p) => p.uid === a.uid);
    return {
      stackPart: stackIndex >= 0 ? this.parts[stackIndex] : null,
      stackIndex,
      groupInstances: this.radials.filter((r) => r.groupUid === a.uid),
    };
  }

  /** Drop queue actions that no longer resolve to a live part. */
  pruneQueue(): void {
    this.stageQueue = this.stageQueue
      .map((st) =>
        st.filter((a) => {
          const hit = this.resolveAction(a);
          return hit.stackPart !== null || hit.groupInstances.length > 0;
        }),
      )
      .filter((st) => st.length > 0);
  }

  /** What the next Space press will do (for the HUD). */
  nextStageLabel(): string {
    const next = this.stageQueue[0];
    if (!next || next.length === 0) return '—';
    const bits = new Set<string>();
    for (const a of next) {
      if (a.kind === 'decouple') bits.add('stage sep');
      else if (a.kind === 'ignite') bits.add('ignition');
      else if (a.kind === 'jettison') bits.add('drop boosters');
      else if (a.kind === 'chute') bits.add('arm chutes');
    }
    return [...bits].join(' + ');
  }

  /** Fire the next stage in the queue, executing every action in it. */
  stage(): StageResult {
    this.pruneQueue();
    const actions = this.stageQueue.shift();
    if (!actions || actions.length === 0) {
      return { msg: 'No stages left', dropped: null, droppedRadials: null };
    }

    const msgs = new Set<string>();
    let dropped: PartInstance[] | null = null;
    let droppedRadials: RadialInstance[] = [];

    // Decouples first (so ignitions in the same stage light the new bottom),
    // deepest decoupler wins if the user stacked several in one stage.
    const decouples = actions
      .filter((a) => a.kind === 'decouple')
      .map((a) => this.resolveAction(a).stackIndex)
      .filter((i) => i >= 0)
      .sort((x, y) => x - y);
    if (decouples.length > 0) {
      const idx = decouples[0]; // topmost listed: drops everything below it
      const h0 = this.stackHeight();
      dropped = this.parts.slice(idx); // decoupler goes with the lower half
      droppedRadials.push(...this.radials.filter((r) => r.hostIndex >= idx));
      this.radials = this.radials.filter((r) => r.hostIndex < idx);
      this.parts = this.parts.slice(0, idx);
      // pos is the stack's geometric center: shift it up so the REMAINING
      // parts keep their world positions (no visual jump on separation)
      _upTmp.set(0, 1, 0).applyQuaternion(this.q);
      this.pos.addScaledVector(_upTmp, (h0 - this.stackHeight()) / 2);
      this.hadThrust = false;
      msgs.add('Stage separation');
    }

    for (const a of actions) {
      const hit = this.resolveAction(a);
      switch (a.kind) {
        case 'ignite': {
          let lit = false;
          if (hit.stackPart && !hit.stackPart.ignited) {
            hit.stackPart.ignited = true;
            lit = true;
          }
          for (const r of hit.groupInstances) {
            if (!r.ignited) {
              r.ignited = true;
              lit = true;
            }
          }
          if (lit) {
            this.hadThrust = false;
            msgs.add('Ignition!');
          }
          break;
        }
        case 'jettison': {
          if (hit.groupInstances.length > 0) {
            droppedRadials.push(...hit.groupInstances);
            this.radials = this.radials.filter(
              (r) => !hit.groupInstances.includes(r),
            );
            msgs.add('Booster separation');
          }
          break;
        }
        case 'chute': {
          const targets = [
            ...(hit.stackPart ? [hit.stackPart] : []),
            ...hit.groupInstances,
          ].filter((c) => !c.torn && !c.deployed && !c.armed);
          if (targets.length > 0) {
            for (const c of targets) c.armed = true;
            msgs.add('Parachutes armed — deploy in atmosphere below 40 km');
          }
          break;
        }
        case 'decouple':
          break; // handled above
      }
    }

    // parts that just left the vessel take their queued actions with them
    this.pruneQueue();

    return {
      msg: msgs.size > 0 ? [...msgs].join(' + ') : 'Stage fired',
      dropped,
      droppedRadials: droppedRadials.length > 0 ? droppedRadials : null,
    };
  }

  /**
   * Reentry burn-off: destroy the part on the end that faces the airflow.
   * Losing the capsule (or the last part) is fatal for the vessel.
   */
  burnOffLeading(top: boolean): { name: string; fatal: boolean } | null {
    if (this.parts.length === 0) return null;
    const idx = top ? 0 : this.parts.length - 1;
    const part = this.parts[idx];
    if (part.def.type === 'capsule' || this.parts.length === 1) {
      this.destroyed = true;
      return { name: part.def.name, fatal: true };
    }
    const h0 = this.stackHeight();
    if (top) {
      this.parts.shift();
      this.radials = this.radials
        .map((r) => ({ ...r, hostIndex: r.hostIndex - 1 }))
        .filter((r) => r.hostIndex >= 0);
    } else {
      this.parts.pop();
      const n = this.parts.length;
      this.radials = this.radials.filter((r) => r.hostIndex < n);
    }
    // keep the surviving parts fixed in world space
    _upTmp.set(0, 1, 0).applyQuaternion(this.q);
    this.pos.addScaledVector(_upTmp, ((h0 - this.stackHeight()) / 2) * (top ? -1 : 1));
    this.pruneQueue();
    return { name: part.def.name, fatal: false };
  }

  deployParachute(): boolean {
    const chutes = this.allChutes().filter((p) => !p.deployed);
    if (chutes.length === 0) return false;
    for (const c of chutes) {
      c.deployed = true;
      c.armed = false;
      c.inflate = 0.05;
    }
    return true;
  }

  deployedChutes(): number {
    return this.allChutes().filter((p) => p.deployed).length;
  }
}

// ---------- craft statistics for the VAB ----------

export interface StageStats {
  index: number; // 1 = first stage to fire
  dv: number; // m/s, vacuum Isp
  twr: number; // vs. home-planet surface gravity
  fuel: number; // kg
}

/**
 * Walk the design's ACTUAL stage list, tracking mass, remaining fuel, and
 * which parts are still attached — so Δv/TWR reflect the user's staging,
 * not a geometric guess.
 */
export function computeStageStats(design: CraftDesign, g = 9.81): StageStats[] {
  const slots = design.slots;
  // live state: remaining fuel per uid, attached set
  const fuelLeft = new Map<number, number>();
  const attached = new Set<number>(); // slot + radial-group uids
  let m0 = 0;
  slots.forEach((s) => {
    attached.add(s.uid);
    fuelLeft.set(s.uid, s.def.fuel ?? 0);
    m0 += s.def.dryMass + (s.def.fuel ?? 0) + (s.def.monoprop ?? 0);
    for (const r of s.radials) {
      attached.add(r.uid);
      fuelLeft.set(r.uid, (r.def.fuel ?? 0) * r.count);
      m0 += r.count * (r.def.dryMass + (r.def.fuel ?? 0) + (r.def.monoprop ?? 0));
    }
  });
  const slotIndexOfUid = (uid: number) => slots.findIndex((s) => s.uid === uid);
  const groupOf = (idx: number) => {
    let gi = 0;
    for (let i = 0; i < idx; i++) if (slots[i].def.type === 'decoupler') gi++;
    return gi;
  };
  const lit = new Set<number>(); // ignited uids

  const dropUid = (uid: number) => {
    if (!attached.has(uid)) return;
    attached.delete(uid);
    lit.delete(uid);
    const si = slotIndexOfUid(uid);
    if (si >= 0) {
      const s = slots[si];
      m0 -= s.def.dryMass + (s.def.monoprop ?? 0) + (fuelLeft.get(uid) ?? 0);
      for (const r of s.radials) dropUid(r.uid);
    } else {
      for (const s of slots) {
        const r = s.radials.find((x) => x.uid === uid);
        if (r) {
          m0 -=
            r.count * (r.def.dryMass + (r.def.monoprop ?? 0)) +
            (fuelLeft.get(uid) ?? 0);
          break;
        }
      }
    }
  };

  const stats: StageStats[] = [];
  design.stages.forEach((stage, k) => {
    // separations first (mass leaves before this stage's engines burn)
    for (const a of stage) {
      if (a.kind === 'decouple') {
        const idx = slotIndexOfUid(a.uid);
        if (idx < 0 || !attached.has(a.uid)) continue;
        for (let i = idx; i < slots.length; i++) dropUid(slots[i].uid);
      } else if (a.kind === 'jettison') {
        dropUid(a.uid);
      }
    }
    for (const a of stage) {
      if (a.kind === 'ignite' && attached.has(a.uid)) lit.add(a.uid);
    }
    // burn everything lit: engines drain their group's tanks; SRBs their own
    let thrust = 0;
    let ispWeighted = 0;
    let fuel = 0;
    const drainedGroups = new Set<number>();
    const drainedSrbs = new Set<number>();
    for (const uid of lit) {
      const si = slotIndexOfUid(uid);
      let def: PartDef | null = null;
      if (si >= 0) def = slots[si].def;
      else {
        for (const s of slots) {
          const r = s.radials.find((x) => x.uid === uid);
          if (r) def = r.def;
        }
      }
      if (!def?.thrust) continue;
      const mult =
        si < 0
          ? (slots
              .flatMap((s) => s.radials)
              .find((r) => r.uid === uid)?.count ?? 1)
          : 1;
      thrust += def.thrust * mult;
      ispWeighted += (def.ispVac ?? 0) * def.thrust * mult;
      if (def.type === 'srb') {
        if (!drainedSrbs.has(uid)) {
          fuel += fuelLeft.get(uid) ?? 0;
          drainedSrbs.add(uid);
        }
      } else if (si >= 0) {
        const gi = groupOf(si);
        if (!drainedGroups.has(gi)) {
          drainedGroups.add(gi);
          slots.forEach((s, i) => {
            if (s.def.type === 'tank' && attached.has(s.uid) && groupOf(i) === gi) {
              fuel += fuelLeft.get(s.uid) ?? 0;
            }
          });
        }
      }
    }
    if (thrust > 0) {
      const isp = ispWeighted / thrust;
      const dv =
        fuel > 0 && m0 > fuel ? isp * G0 * Math.log(m0 / (m0 - fuel)) : 0;
      stats.push({ index: k + 1, dv, twr: thrust / (m0 * g), fuel });
      // consume the fuel (mass drops; tanks/SRBs empty for later stages)
      for (const uid of drainedSrbs) fuelLeft.set(uid, 0);
      for (const gi of drainedGroups) {
        slots.forEach((s, i) => {
          if (s.def.type === 'tank' && attached.has(s.uid) && groupOf(i) === gi) {
            fuelLeft.set(s.uid, 0);
          }
        });
      }
      m0 -= fuel;
    }
  });
  return stats;
}

/** Convenience for legacy sample-craft slot lists. */
export function designTotals(design: CraftDesign): { mass: number; height: number; partCount: number } {
  let mass = 0;
  let partCount = 0;
  for (const s of design.slots) {
    mass += s.def.dryMass + (s.def.fuel ?? 0) + (s.def.monoprop ?? 0);
    partCount++;
    for (const r of s.radials) {
      mass += r.count * (r.def.dryMass + (r.def.fuel ?? 0) + (r.def.monoprop ?? 0));
      partCount += r.count;
    }
  }
  const height = design.slots.reduce((s, x) => s + x.def.height, 0);
  return { mass, height, partCount };
}

export type { CraftSlot };
