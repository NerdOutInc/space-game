import * as THREE from 'three';
import { Body, HOME } from '../universe/bodies';
import { G0, PartDef } from './parts';

export interface PartInstance {
  def: PartDef;
  fuel: number;
  ignited: boolean;
  deployed: boolean;
}

export interface StageResult {
  msg: string;
  dropped: PartInstance[] | null;
}

interface EngineFiring {
  part: PartInstance;
  thrust: number; // N, after throttle
  mdot: number; // kg/s
}

export class Vessel {
  parts: PartInstance[]; // ordered top → bottom

  name = 'Untitled Craft';
  /** The original build, kept for "revert to launch". */
  readonly defs: PartDef[];

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
  /** Surface-fixed unit direction of the landing spot (body frame). */
  landedDir = new THREE.Vector3(-1, 0, 0); // sunlit side at t=0
  launchedAt: number | null = null;

  private hadThrust = false;

  constructor(defs: PartDef[], body: Body = HOME) {
    this.defs = [...defs];
    this.parts = defs.map((def) => ({
      def,
      fuel: def.fuel ?? 0,
      ignited: false,
      deployed: false,
    }));
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

  stageCount(): number {
    return this.groups().length;
  }

  mass(): number {
    let m = 0;
    for (const p of this.parts) m += p.def.dryMass + p.fuel;
    return m;
  }

  stackHeight(): number {
    let h = 0;
    for (const p of this.parts) h += p.def.height;
    return h;
  }

  dragArea(): number {
    let cda = 1.5; // rough Cd*A for the whole stack
    for (const p of this.parts) {
      if (p.def.type === 'parachute' && p.deployed) cda += 280;
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
    for (const p of bottom) {
      if ((p.def.type !== 'engine' && p.def.type !== 'srb') || !p.ignited) continue;
      const lvl = p.def.throttleable === false ? 1 : this.throttle;
      if (lvl <= 1e-3) continue;
      const avail = p.def.type === 'srb' ? p.fuel : tankFuel;
      if (avail <= 0) continue;
      const isp = p.def.ispVac! + (p.def.ispAtm! - p.def.ispVac!) * pressureRatio;
      const thrust = p.def.thrust! * lvl;
      out.push({ part: p, thrust, mdot: thrust / (isp * G0) });
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
    const anyIgnited = bottom.some(
      (p) => (p.def.type === 'engine' || p.def.type === 'srb') && p.ignited,
    );
    if (this.hadThrust && anyIgnited && this.throttle > 1e-3) {
      const canFire = this.firingEngines(pressureRatio).length > 0;
      if (!canFire) {
        this.hadThrust = false;
        return true;
      }
    }
    return false;
  }

  /** Fuel fraction of the current bottom stage (for the HUD gauge). */
  stageFuelFraction(): number {
    const bottom = this.bottomGroup();
    let cap = 0;
    let cur = 0;
    for (const p of bottom) {
      if (p.def.fuel) {
        cap += p.def.fuel;
        cur += p.fuel;
      }
    }
    return cap > 0 ? cur / cap : 0;
  }

  /** Activate the next stage: ignite unlit engines, or decouple and ignite. */
  stage(): StageResult {
    const bottom = this.bottomGroup();
    const engines = bottom.filter(
      (p) => p.def.type === 'engine' || p.def.type === 'srb',
    );
    const unlit = engines.filter((e) => !e.ignited);
    if (unlit.length > 0) {
      unlit.forEach((e) => (e.ignited = true));
      this.hadThrust = false;
      return { msg: 'Ignition!', dropped: null };
    }
    const idx = this.parts.map((p) => p.def.type).lastIndexOf('decoupler');
    if (idx === -1) return { msg: 'No stages left', dropped: null };
    const dropped = this.parts.slice(idx); // decoupler goes with the lower half
    this.parts = this.parts.slice(0, idx);
    // Auto-ignite the new bottom stage's engines.
    for (const p of this.bottomGroup()) {
      if (p.def.type === 'engine' || p.def.type === 'srb') p.ignited = true;
    }
    this.hadThrust = false;
    return { msg: 'Stage separation', dropped };
  }

  deployParachute(): boolean {
    const chute = this.parts.find((p) => p.def.type === 'parachute' && !p.deployed);
    if (!chute) return false;
    chute.deployed = true;
    return true;
  }

  anyEngineIgnited(): boolean {
    return this.bottomGroup().some(
      (p) => (p.def.type === 'engine' || p.def.type === 'srb') && p.ignited,
    );
  }
}

// ---------- VAB stage statistics (Tsiolkovsky per stage) ----------

export interface StageStats {
  index: number; // 1 = first stage to burn (bottom)
  dv: number; // m/s, vacuum Isp
  twr: number; // vs. home-planet surface gravity
  fuel: number; // kg
}

export function computeStageStats(defs: PartDef[], g = 9.81): StageStats[] {
  // Split into groups (top → bottom) tracking decoupler masses between them.
  const groups: PartDef[][] = [];
  const decouplers: PartDef[] = []; // decoupler above group i sits at decouplers[i-1]
  let cur: PartDef[] = [];
  for (const d of defs) {
    if (d.type === 'decoupler') {
      groups.push(cur);
      decouplers.push(d);
      cur = [];
    } else {
      cur.push(d);
    }
  }
  groups.push(cur);

  let m0 = defs.reduce((s, d) => s + d.dryMass + (d.fuel ?? 0), 0);
  const stats: StageStats[] = [];
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g_ = groups[gi];
    const engines = g_.filter((d) => d.type === 'engine' || d.type === 'srb');
    const fuel = g_.reduce((s, d) => s + (d.fuel ?? 0), 0);
    const thrust = engines.reduce((s, d) => s + (d.thrust ?? 0), 0);
    const isp =
      engines.length > 0
        ? engines.reduce((s, d) => s + (d.ispVac ?? 0), 0) / engines.length
        : 0;
    const dv = isp > 0 && fuel > 0 && m0 > fuel ? isp * G0 * Math.log(m0 / (m0 - fuel)) : 0;
    const twr = thrust > 0 ? thrust / (m0 * g) : 0;
    stats.push({ index: groups.length - gi, dv, twr, fuel });
    // Drop this group (wet) plus the decoupler above it.
    const groupWet = g_.reduce((s, d) => s + d.dryMass + (d.fuel ?? 0), 0);
    const dec = gi > 0 ? decouplers[gi - 1].dryMass : 0;
    m0 -= groupWet + dec;
  }
  return stats;
}
