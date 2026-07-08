export const G0 = 9.80665;

export type PartType =
  | 'capsule'
  | 'tank'
  | 'engine'
  | 'decoupler'
  | 'parachute'
  | 'srb'
  | 'dock'
  | 'shield'
  | 'nose'
  | 'adapter'
  | 'fin'
  | 'rcs'
  | 'legs';

/** Where a part may attach: in the stack, on a side surface, or either. */
export type MountType = 'stack' | 'radial' | 'both';

export interface PartDef {
  id: string;
  name: string;
  type: PartType;
  mount: MountType;
  dryMass: number; // kg
  fuel?: number; // kg of propellant carried (tanks, SRBs)
  monoprop?: number; // kg carried by RCS blocks
  thrust?: number; // N
  rcsThrust?: number; // N per block
  ispVac?: number; // s
  ispAtm?: number; // s, at 1 atm
  throttleable?: boolean;
  finArea?: number; // Cd·A per fin for aero torque/drag
  height: number; // m
  radius: number; // m
  info: string;
  /** Science cost to unlock; parts without a cost are available from the start. */
  cost?: number;
}

export const PARTS: PartDef[] = [
  // ---- Command & Recovery ----
  {
    id: 'capsule',
    name: 'Z-1 "Acorn" Capsule',
    type: 'capsule',
    mount: 'stack',
    dryMass: 800,
    height: 1.3,
    radius: 0.625,
    info: 'Seats one brave zenaut. Provides control and reaction wheels.',
  },
  {
    id: 'parachute',
    name: 'P-6 Parachute',
    type: 'parachute',
    mount: 'both',
    dryMass: 100,
    height: 0.4,
    radius: 0.3,
    info: 'Arm via staging or deploy with P. Stack-top or radial.',
  },
  {
    id: 'dock-small',
    name: 'D-0 Junior Dock',
    type: 'dock',
    mount: 'stack',
    dryMass: 60,
    height: 0.3,
    radius: 0.3,
    info: 'Compact magnetic port for capsules. Top of the stack, nose-first, gently. U undocks.',
    cost: 25,
  },
  {
    id: 'dock',
    name: 'D-1 Magnetic Dock',
    type: 'dock',
    mount: 'stack',
    dryMass: 150,
    height: 0.45,
    radius: 0.625,
    info: 'Magnetic docking port — put it on TOP. Approach another port nose-first, slowly; magnets do the rest. U undocks.',
    cost: 40,
  },
  {
    id: 'shield',
    name: 'AB-7 Heat Shield',
    type: 'shield',
    mount: 'stack',
    dryMass: 300,
    height: 0.35,
    radius: 0.72,
    info: 'Ablative dish. Mount at the END that meets the airflow (usually the bottom) — it soaks up reentry heat that would cook anything else.',
    cost: 30,
  },
  // ---- Propulsion: tanks ----
  {
    id: 'tank-small',
    name: 'FT-400 Fuel Tank',
    type: 'tank',
    mount: 'stack',
    dryMass: 250,
    fuel: 2000,
    height: 1.9,
    radius: 0.625,
    info: '2.0 t of propellant. Feeds engines in the same stage.',
  },
  {
    id: 'tank-large',
    name: 'FT-800 Fuel Tank',
    type: 'tank',
    mount: 'stack',
    dryMass: 500,
    fuel: 4000,
    height: 3.8,
    radius: 0.625,
    info: '4.0 t of propellant. Twice the tank, twice the fun.',
    cost: 35,
  },
  {
    id: 'tank-xl',
    name: 'FT-1600 Fuel Tank',
    type: 'tank',
    mount: 'stack',
    dryMass: 1000,
    fuel: 8000,
    height: 7.0,
    radius: 0.625,
    info: '8.0 t of propellant for serious lifting.',
    cost: 60,
  },
  // ---- Propulsion: engines ----
  {
    id: 'engine-lift',
    name: '"Mule" Lifter Engine',
    type: 'engine',
    mount: 'stack',
    dryMass: 1500,
    thrust: 215_000,
    ispVac: 320,
    ispAtm: 265,
    throttleable: true,
    height: 1.4,
    radius: 0.625,
    info: '215 kN. Workhorse first-stage engine, decent everywhere.',
  },
  {
    id: 'engine-heavy',
    name: '"Bison" Heavy Lifter',
    type: 'engine',
    mount: 'stack',
    dryMass: 3200,
    thrust: 650_000,
    ispVac: 300,
    ispAtm: 278,
    throttleable: true,
    height: 2.0,
    radius: 0.625,
    info: '650 kN of first-stage muscle for XL stacks.',
    cost: 90,
  },
  {
    id: 'engine-vac',
    name: '"Wisp" Vacuum Engine',
    type: 'engine',
    mount: 'stack',
    dryMass: 500,
    thrust: 60_000,
    ispVac: 345,
    ispAtm: 90,
    throttleable: true,
    height: 1.0,
    radius: 0.625,
    info: '60 kN, superb in vacuum, feeble in atmosphere. Upper stages.',
    cost: 45,
  },
  {
    id: 'engine-tiny',
    name: '"Pixie" Lander Engine',
    type: 'engine',
    mount: 'stack',
    dryMass: 130,
    thrust: 20_000,
    ispVac: 335,
    ispAtm: 140,
    throttleable: true,
    height: 0.5,
    radius: 0.4,
    info: '20 kN featherweight — landers and final kicks.',
    cost: 35,
  },
  {
    id: 'engine-nuclear',
    name: '"Prometheus" Nuclear Engine',
    type: 'engine',
    mount: 'stack',
    dryMass: 2600,
    thrust: 45_000,
    ispVac: 720,
    ispAtm: 130,
    throttleable: true,
    height: 2.6,
    radius: 0.625,
    info: '45 kN at a monstrous 720 s vacuum Isp. Interplanetary cruiser.',
    cost: 160,
  },
  {
    id: 'srb',
    name: '"Anvil" Solid Booster',
    type: 'srb',
    mount: 'both',
    dryMass: 750,
    fuel: 3300,
    thrust: 197_000,
    ispVac: 195,
    ispAtm: 170,
    throttleable: false,
    height: 3.5,
    radius: 0.5,
    info: '197 kN of no-off-switch enthusiasm. Stack it or strap it on.',
    cost: 20,
  },
  // ---- Aero & Structural ----
  {
    id: 'nose',
    name: 'NC-6 Nose Cone',
    type: 'nose',
    mount: 'stack',
    dryMass: 60,
    height: 0.9,
    radius: 0.625,
    info: 'Caps a stack and sheds drag. Pointy end up.',
    cost: 10,
  },
  {
    id: 'adapter',
    name: 'AD-25 Adapter',
    type: 'adapter',
    mount: 'stack',
    dryMass: 120,
    height: 0.6,
    radius: 0.625,
    info: 'Structural taper. Makes stacks look intentional.',
    cost: 10,
  },
  {
    id: 'fin',
    name: 'AV-1 Fin',
    type: 'fin',
    mount: 'radial',
    dryMass: 45,
    finArea: 0.35,
    height: 0.9,
    radius: 0.12,
    info: 'Radial fin. Mounted low, it weathervanes the rocket into the airstream — passive stability during ascent.',
    cost: 15,
  },
  // ---- Landing & Maneuvering ----
  {
    id: 'legs',
    name: 'LT-2 Landing Legs',
    type: 'legs',
    mount: 'radial',
    dryMass: 75,
    height: 1.1,
    radius: 0.12,
    info: 'Deployable struts (B toggles). Landing on legs tolerates up to 20 m/s.',
    cost: 30,
  },
  {
    id: 'rcs',
    name: 'RV-4 RCS Block',
    type: 'rcs',
    mount: 'radial',
    dryMass: 55,
    monoprop: 40,
    rcsThrust: 3000,
    height: 0.3,
    radius: 0.15,
    info: 'Self-contained thruster quad (V toggles, IJKL translates). Docking hands.',
    cost: 45,
  },
  // ---- Structural ----
  {
    id: 'decoupler',
    name: 'TD-12 Decoupler',
    type: 'decoupler',
    mount: 'stack',
    dryMass: 50,
    height: 0.3,
    radius: 0.625,
    info: 'Separates stages. Everything below it is dropped when staged.',
  },
];

export const PART_BY_ID: Record<string, PartDef> = Object.fromEntries(
  PARTS.map((p) => [p.id, p]),
);

export const BOOSTER_DEF_ID = 'srb';
export const CHUTE_DEF_ID = 'parachute';

/** Which stack parts can host radial attachments. */
export function canHostRadials(def: PartDef): boolean {
  return (
    def.type === 'tank' ||
    def.type === 'srb' ||
    def.type === 'capsule' ||
    def.type === 'adapter' ||
    def.type === 'dock'
  );
}

/** Legacy helpers (VAB quick-toggles use them too). */
export function canHostBoosters(def: PartDef): boolean {
  return def.type === 'tank' || def.type === 'srb';
}
export function canHostChutes(def: PartDef): boolean {
  return def.type === 'capsule' || def.type === 'tank' || def.type === 'dock';
}

export interface SampleSlot {
  id: string;
  radials?: Array<{ id: string; count: number }>;
}

/**
 * Three-stage orbital launcher whose return stage is docking-capable:
 * junior dock on the nose, radial parachutes on the capsule, heat shield
 * below, fins on the first stage. Needs unlocked parts.
 */
export const SAMPLE_ROCKET: SampleSlot[] = [
  { id: 'dock-small' },
  { id: 'capsule', radials: [{ id: 'parachute', count: 2 }] },
  { id: 'shield' },
  { id: 'decoupler' },
  { id: 'tank-small' },
  { id: 'engine-vac' },
  { id: 'decoupler' },
  { id: 'tank-large', radials: [] },
  { id: 'tank-large', radials: [{ id: 'fin', count: 4 }] },
  { id: 'engine-lift' },
];

/** Starter-parts suborbital hopper — enough to reach space and come home. */
export const SAMPLE_STARTER: SampleSlot[] = [
  { id: 'parachute' },
  { id: 'capsule' },
  { id: 'tank-small' },
  { id: 'tank-small' },
  { id: 'engine-lift' },
];
