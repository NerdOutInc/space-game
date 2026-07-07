export const G0 = 9.80665;

export type PartType =
  | 'capsule'
  | 'tank'
  | 'engine'
  | 'decoupler'
  | 'parachute'
  | 'srb'
  | 'dock'
  | 'shield';

export interface PartDef {
  id: string;
  name: string;
  type: PartType;
  dryMass: number; // kg
  fuel?: number; // kg of propellant carried (tanks, SRBs)
  thrust?: number; // N
  ispVac?: number; // s
  ispAtm?: number; // s, at 1 atm
  throttleable?: boolean;
  height: number; // m
  radius: number; // m
  info: string;
  /** Science cost to unlock; parts without a cost are available from the start. */
  cost?: number;
}

export const PARTS: PartDef[] = [
  {
    id: 'capsule',
    name: 'Z-1 "Acorn" Capsule',
    type: 'capsule',
    dryMass: 800,
    height: 1.3,
    radius: 0.625,
    info: 'Seats one brave zenaut. Provides control and reaction wheels.',
  },
  {
    id: 'parachute',
    name: 'P-6 Parachute',
    type: 'parachute',
    dryMass: 100,
    height: 0.4,
    radius: 0.3,
    info: 'Deploy with P below 40 km in atmosphere. Put it on top.',
  },
  {
    id: 'dock-small',
    name: 'D-0 Junior Dock',
    type: 'dock',
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
    dryMass: 300,
    height: 0.35,
    radius: 0.72,
    info: 'Ablative dish. Mount at the END that meets the airflow (usually the bottom) — it soaks up reentry heat that would cook anything else.',
    cost: 30,
  },
  {
    id: 'tank-small',
    name: 'FT-400 Fuel Tank',
    type: 'tank',
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
    dryMass: 500,
    fuel: 4000,
    height: 3.8,
    radius: 0.625,
    info: '4.0 t of propellant. Twice the tank, twice the fun.',
    cost: 35,
  },
  {
    id: 'engine-lift',
    name: '"Mule" Lifter Engine',
    type: 'engine',
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
    id: 'engine-vac',
    name: '"Wisp" Vacuum Engine',
    type: 'engine',
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
    id: 'decoupler',
    name: 'TD-12 Decoupler',
    type: 'decoupler',
    dryMass: 50,
    height: 0.3,
    radius: 0.625,
    info: 'Separates stages. Everything below it is dropped when staged.',
  },
  {
    id: 'srb',
    name: '"Anvil" Solid Booster',
    type: 'srb',
    dryMass: 750,
    fuel: 3300,
    thrust: 197_000,
    ispVac: 195,
    ispAtm: 170,
    throttleable: false,
    height: 3.5,
    radius: 0.5,
    info: '197 kN of no-off-switch enthusiasm. Cheap first-stage kick.',
    cost: 20,
  },
];

export const PART_BY_ID: Record<string, PartDef> = Object.fromEntries(
  PARTS.map((p) => [p.id, p]),
);

/**
 * One slot of a craft design: a stack part plus optional radially-attached
 * side boosters (Anvil SRBs) and radial parachutes, in symmetric pairs.
 */
export interface CraftPart {
  def: PartDef;
  boosters: number;
  chutes: number;
}

export const BOOSTER_DEF_ID = 'srb';
export const CHUTE_DEF_ID = 'parachute';

/** Which stack parts can host radial boosters. */
export function canHostBoosters(def: PartDef): boolean {
  return def.type === 'tank' || def.type === 'srb';
}

/** Which stack parts can host radial parachutes. */
export function canHostChutes(def: PartDef): boolean {
  return def.type === 'capsule' || def.type === 'tank' || def.type === 'dock';
}

export interface SampleSlot {
  id: string;
  boosters?: number;
  chutes?: number;
}

/**
 * Three-stage orbital launcher whose return stage is docking-capable:
 * junior dock on the nose, radial parachutes on the capsule, heat shield
 * below. Needs unlocked parts.
 */
export const SAMPLE_ROCKET: SampleSlot[] = [
  { id: 'dock-small' },
  { id: 'capsule', chutes: 2 },
  { id: 'shield' },
  { id: 'decoupler' },
  { id: 'tank-small' },
  { id: 'engine-vac' },
  { id: 'decoupler' },
  { id: 'tank-large' },
  { id: 'tank-large' },
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
