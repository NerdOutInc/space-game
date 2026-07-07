export const G0 = 9.80665;

export type PartType = 'capsule' | 'tank' | 'engine' | 'decoupler' | 'parachute' | 'srb';

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
  },
];

export const PART_BY_ID: Record<string, PartDef> = Object.fromEntries(
  PARTS.map((p) => [p.id, p]),
);

export const SAMPLE_ROCKET: string[] = [
  'parachute',
  'capsule',
  'tank-small',
  'engine-vac',
  'decoupler',
  'tank-large',
  'tank-large',
  'engine-lift',
];
