import * as THREE from 'three';
import { Body, HOME } from '../universe/bodies';
import { PAD_DIR } from '../universe/terrain';
import { BOOSTER_DEF_ID, CraftPart, G0, PART_BY_ID, PartDef } from './parts';

export interface PartInstance {
  def: PartDef;
  fuel: number;
  ignited: boolean;
  deployed: boolean;
  /** Parachutes: staged and waiting for safe atmosphere conditions. */
  armed: boolean;
}

/** A radially-attached side booster, tied to a stack part by index. */
export interface BoosterInstance extends PartInstance {
  hostIndex: number;
}

export interface StageResult {
  msg: string;
  dropped: PartInstance[] | null;
  droppedBoosters: BoosterInstance[] | null;
}

interface EngineFiring {
  part: PartInstance;
  thrust: number; // N, after throttle
  mdot: number; // kg/s
}

function newInstance(def: PartDef): PartInstance {
  return { def, fuel: def.fuel ?? 0, ignited: false, deployed: false, armed: false };
}

export class Vessel {
  parts: PartInstance[]; // stack, ordered top → bottom
  boosters: BoosterInstance[] = [];

  name = 'Untitled Craft';
  /** The original build, kept for "revert to launch". */
  readonly craft: CraftPart[];

  body: Body;
  /** Position/velocity relative to `body` center, non-rotating frame. */
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  q = new THREE.Quaternion();
  angVel = new THREE.Vector3(); // world frame, rad/s

  throttle = 1;
  sas = true;
  landed = true;
  destroyed = false;
  /** Has this vessel ever left the atmosphere? (drives the recovery bonus) */
  reachedSpace = false;
  /** Surface-fixed unit direction of the landing spot (body frame). */
  landedDir = PAD_DIR.clone();
  launchedAt: number | null = null;

  private hadThrust = false;

  constructor(craft: CraftPart[], body: Body = HOME) {
    this.craft = craft.map((c) => ({ def: c.def, boosters: c.boosters }));
    this.parts = craft.map((c) => newInstance(c.def));
    const srb = PART_BY_ID[BOOSTER_DEF_ID];
    craft.forEach((c, i) => {
      for (let k = 0; k < (c.boosters ?? 0); k++) {
        this.boosters.push({ ...newInstance(srb), hostIndex: i });
      }
    });
    this.body = body;
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

  /** Index of the first stack part in the bottom group. */
  private bottomGroupStart(): number {
    return this.parts.map((p) => p.def.type).lastIndexOf('decoupler') + 1;
  }

  private bottomBoosters(): BoosterInstance[] {
    const start = this.bottomGroupStart();
    return this.boosters.filter((b) => b.hostIndex >= start);
  }

  stageCount(): number {
    return this.groups().length;
  }

  mass(): number {
    let m = 0;
    for (const p of this.parts) m += p.def.dryMass + p.fuel;
    for (const b of this.boosters) m += b.def.dryMass + b.fuel;
    return m;
  }

  stackHeight(): number {
    let h = 0;
    for (const p of this.parts) h += p.def.height;
    return h;
  }

  dragArea(): number {
    let cda = 1.5; // rough Cd*A for the whole stack
    cda += this.boosters.length * 0.5;
    for (const p of this.parts) {
      if (p.def.type === 'parachute' && p.deployed) cda += 380;
    }
    return cda;
  }

  hasCapsule(): boolean {
    return this.parts.some((p) => p.def.type === 'capsule');
  }

  /** Engines currently producing thrust, with per-engine mass flow. */
  firingEngines(pressureRatio: number): EngineFiring[] {
    const bottom = this.bottomGroup();
    const tankFuel = bottom
      .filter((p) => p.def.type === 'tank')
      .reduce((s, p) => s + p.fuel, 0);
    const out: EngineFiring[] = [];
    const consider = (p: PartInstance) => {
      if ((p.def.type !== 'engine' && p.def.type !== 'srb') || !p.ignited) return;
      const lvl = p.def.throttleable === false ? 1 : this.throttle;
      if (lvl <= 1e-3) return;
      const avail = p.def.type === 'srb' ? p.fuel : tankFuel;
      if (avail <= 0) return;
      const isp = p.def.ispVac! + (p.def.ispAtm! - p.def.ispVac!) * pressureRatio;
      const thrust = p.def.thrust! * lvl;
      out.push({ part: p, thrust, mdot: thrust / (isp * G0) });
    };
    for (const p of bottom) consider(p);
    for (const b of this.boosters) consider(b); // boosters carry their own fuel
    return out;
  }

  totalThrust(pressureRatio: number): number {
    return this.firingEngines(pressureRatio).reduce((s, e) => s + e.thrust, 0);
  }

  /** Consume propellant for dt seconds. Returns true if a flameout just occurred. */
  burn(dt: number, pressureRatio: number): boolean {
    const firing = this.firingEngines(pressureRatio);
    if (firing.length > 0) this.hadThrust = true;

    const bottom = this.bottomGroup();
    const tanks = bottom.filter((p) => p.def.type === 'tank');
    let tankDemand = 0;
    for (const f of firing) {
      if (f.part.def.type === 'srb') {
        f.part.fuel = Math.max(0, f.part.fuel - f.mdot * dt);
      } else {
        tankDemand += f.mdot * dt;
      }
    }
    if (tankDemand > 0) {
      const total = tanks.reduce((s, t) => s + t.fuel, 0);
      const take = Math.min(tankDemand, total);
      if (total > 0) {
        const ratio = take / total;
        for (const t of tanks) t.fuel -= t.fuel * ratio;
      }
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
      this.bottomGroup().some(
        (p) => (p.def.type === 'engine' || p.def.type === 'srb') && p.ignited,
      ) || this.boosters.some((b) => b.ignited)
    );
  }

  /** Ignited side boosters that have burned dry (ready to jettison). */
  hasSpentBoosters(): boolean {
    return (
      this.boosters.length > 0 &&
      this.boosters.every((b) => !b.ignited || b.fuel <= 0) &&
      this.boosters.some((b) => b.ignited && b.fuel <= 0)
    );
  }

  /** Fuel fraction of the current bottom stage (for the HUD gauge). */
  stageFuelFraction(): number {
    let cap = 0;
    let cur = 0;
    for (const p of this.bottomGroup()) {
      if (p.def.fuel) {
        cap += p.def.fuel;
        cur += p.fuel;
      }
    }
    for (const b of this.bottomBoosters()) {
      cap += b.def.fuel ?? 0;
      cur += b.fuel;
    }
    return cap > 0 ? cur / cap : 0;
  }

  /** What the next Space press will do (for the HUD). */
  nextStageLabel(): string {
    const bottom = this.bottomGroup();
    const engines = bottom.filter(
      (p) => p.def.type === 'engine' || p.def.type === 'srb',
    );
    const unlitCore = engines.some((e) => !e.ignited);
    const unlitBoosters = this.bottomBoosters().some((b) => !b.ignited);
    if (unlitCore || unlitBoosters) return 'ignition';
    if (this.hasSpentBoosters()) return 'drop boosters';
    if (this.parts.some((p) => p.def.type === 'decoupler')) return 'stage sep';
    if (this.parts.some((p) => p.def.type === 'parachute' && !p.deployed && !p.armed))
      return 'arm chute';
    return '—';
  }

  /**
   * Activate the next stage, KSP-style:
   * ignite → jettison spent boosters → decouple (+auto-ignite) → arm chutes.
   */
  stage(): StageResult {
    const none = { dropped: null, droppedBoosters: null };
    const bottom = this.bottomGroup();
    const engines = bottom.filter(
      (p) => p.def.type === 'engine' || p.def.type === 'srb',
    );
    const unlit: PartInstance[] = [
      ...engines.filter((e) => !e.ignited),
      ...this.bottomBoosters().filter((b) => !b.ignited),
    ];
    if (unlit.length > 0) {
      unlit.forEach((e) => (e.ignited = true));
      this.hadThrust = false;
      return { msg: 'Ignition!', ...none };
    }

    if (this.hasSpentBoosters()) {
      const spent = this.boosters.filter((b) => b.ignited);
      this.boosters = this.boosters.filter((b) => !b.ignited);
      return { msg: 'Booster separation', dropped: null, droppedBoosters: spent };
    }

    const idx = this.parts.map((p) => p.def.type).lastIndexOf('decoupler');
    if (idx !== -1) {
      const dropped = this.parts.slice(idx); // decoupler goes with the lower half
      const droppedBoosters = this.boosters.filter((b) => b.hostIndex >= idx);
      this.boosters = this.boosters.filter((b) => b.hostIndex < idx);
      this.parts = this.parts.slice(0, idx);
      // Auto-ignite the new bottom stage's engines and boosters.
      for (const p of this.bottomGroup()) {
        if (p.def.type === 'engine' || p.def.type === 'srb') p.ignited = true;
      }
      for (const b of this.bottomBoosters()) b.ignited = true;
      this.hadThrust = false;
      return {
        msg: 'Stage separation',
        dropped,
        droppedBoosters: droppedBoosters.length ? droppedBoosters : null,
      };
    }

    const chute = this.parts.find(
      (p) => p.def.type === 'parachute' && !p.deployed && !p.armed,
    );
    if (chute) {
      chute.armed = true;
      return {
        msg: 'Parachute armed — deploys in atmosphere below 40 km',
        ...none,
      };
    }

    return { msg: 'No stages left', ...none };
  }

  deployParachute(): boolean {
    const chute = this.parts.find((p) => p.def.type === 'parachute' && !p.deployed);
    if (!chute) return false;
    chute.deployed = true;
    chute.armed = false;
    return true;
  }

  deployedChutes(): number {
    return this.parts.filter((p) => p.def.type === 'parachute' && p.deployed).length;
  }
}

// ---------- craft statistics for the VAB ----------

export interface StageStats {
  index: number; // 1 = first stage to burn (bottom)
  dv: number; // m/s, vacuum Isp
  twr: number; // vs. home-planet surface gravity
  fuel: number; // kg
}

interface GroupInfo {
  parts: PartDef[];
  boosters: number;
  decouplerAbove: PartDef | null;
}

function splitGroups(craft: CraftPart[]): GroupInfo[] {
  const groups: GroupInfo[] = [];
  let cur: GroupInfo = { parts: [], boosters: 0, decouplerAbove: null };
  for (const c of craft) {
    if (c.def.type === 'decoupler') {
      groups.push(cur);
      cur = { parts: [], boosters: 0, decouplerAbove: c.def };
    } else {
      cur.parts.push(c.def);
      cur.boosters += c.boosters ?? 0;
    }
  }
  groups.push(cur);
  return groups; // top → bottom
}

export function computeStageStats(craft: CraftPart[], g = 9.81): StageStats[] {
  const srb = PART_BY_ID[BOOSTER_DEF_ID];
  const groups = splitGroups(craft);
  let m0 = craft.reduce(
    (s, c) =>
      s +
      c.def.dryMass +
      (c.def.fuel ?? 0) +
      (c.boosters ?? 0) * (srb.dryMass + (srb.fuel ?? 0)),
    0,
  );
  const stats: StageStats[] = [];
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const grp = groups[gi];
    const engines = grp.parts.filter((d) => d.type === 'engine' || d.type === 'srb');
    let thrust = engines.reduce((s, d) => s + (d.thrust ?? 0), 0);
    let fuel = grp.parts.reduce((s, d) => s + (d.fuel ?? 0), 0);
    let ispWeighted = engines.reduce((s, d) => s + (d.ispVac ?? 0) * (d.thrust ?? 0), 0);
    if (grp.boosters > 0) {
      thrust += grp.boosters * (srb.thrust ?? 0);
      fuel += grp.boosters * (srb.fuel ?? 0);
      ispWeighted += grp.boosters * (srb.ispVac ?? 0) * (srb.thrust ?? 0);
    }
    const isp = thrust > 0 ? ispWeighted / thrust : 0;
    const dv =
      isp > 0 && fuel > 0 && m0 > fuel ? isp * G0 * Math.log(m0 / (m0 - fuel)) : 0;
    const twr = thrust > 0 ? thrust / (m0 * g) : 0;
    stats.push({ index: groups.length - gi, dv, twr, fuel });
    const groupWet =
      grp.parts.reduce((s, d) => s + d.dryMass + (d.fuel ?? 0), 0) +
      grp.boosters * (srb.dryMass + (srb.fuel ?? 0));
    m0 -= groupWet + (grp.decouplerAbove?.dryMass ?? 0);
  }
  return stats;
}

/** Human-readable stage sequence — one line per Space press. */
export function describeStages(craft: CraftPart[]): string[] {
  const groups = splitGroups(craft);
  const out: string[] = [];
  const engineNames = (grp: GroupInfo): string[] => {
    const engines = grp.parts.filter((d) => d.type === 'engine' || d.type === 'srb');
    const bits = engines.map((e) => e.name.replace(/".*?" /, '').replace(' Engine', ''));
    if (grp.boosters > 0) bits.push(`${grp.boosters}× side booster`);
    return bits;
  };
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const grp = groups[gi];
    const bits = engineNames(grp);
    if (gi === groups.length - 1) {
      // first stage: its own ignition press
      if (bits.length > 0) out.push(`Ignite ${bits.join(' + ')}`);
    }
    if (grp.boosters > 0) out.push('Jettison boosters');
    if (gi > 0) {
      const next = engineNames(groups[gi - 1]);
      out.push(next.length > 0 ? `Decouple + ignite ${next.join(' + ')}` : 'Decouple');
    }
  }
  if (craft.some((c) => c.def.type === 'parachute')) out.push('Arm parachute');
  return out;
}
