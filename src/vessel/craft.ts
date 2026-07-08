import { PartDef } from './parts';

/**
 * The craft design model behind the VAB: an ordered stack of slots (top →
 * bottom), each optionally carrying symmetric radial groups, plus an
 * EXPLICIT, editable stage list. stages[0] fires first; the sim executes
 * the list literally, KSP-style.
 */

let uidCounter = 1;
export function nextUid(): number {
  return uidCounter++;
}

export interface RadialGroup {
  uid: number;
  def: PartDef;
  count: number; // symmetric copies (1, 2, 3 or 4)
}

export interface CraftSlot {
  uid: number;
  def: PartDef;
  radials: RadialGroup[];
}

export type StageAction =
  | { kind: 'ignite'; uid: number } // stack engine/SRB or radial SRB group
  | { kind: 'decouple'; uid: number } // decoupler slot
  | { kind: 'jettison'; uid: number } // radial SRB group
  | { kind: 'chute'; uid: number }; // arm a parachute (slot or radial group)

export interface CraftDesign {
  slots: CraftSlot[];
  stages: StageAction[][];
}

export function makeSlot(def: PartDef): CraftSlot {
  return { uid: nextUid(), def, radials: [] };
}

export function emptyCraft(): CraftDesign {
  return { slots: [], stages: [] };
}

/** All actions a given design SHOULD contain, each exactly once. */
function requiredActions(slots: CraftSlot[]): StageAction[] {
  const out: StageAction[] = [];
  for (const s of slots) {
    if (s.def.type === 'engine' || s.def.type === 'srb') {
      out.push({ kind: 'ignite', uid: s.uid });
    } else if (s.def.type === 'decoupler') {
      out.push({ kind: 'decouple', uid: s.uid });
    } else if (s.def.type === 'parachute') {
      out.push({ kind: 'chute', uid: s.uid });
    }
    for (const r of s.radials) {
      if (r.def.type === 'srb') {
        out.push({ kind: 'ignite', uid: r.uid });
        out.push({ kind: 'jettison', uid: r.uid });
      } else if (r.def.type === 'parachute') {
        out.push({ kind: 'chute', uid: r.uid });
      }
    }
  }
  return out;
}

/**
 * Sensible default staging, bottom group first:
 * ignite (engines + strapped boosters) → jettison boosters → decouple +
 * ignite the next group … and finally arm every parachute.
 */
export function defaultStages(slots: CraftSlot[]): StageAction[][] {
  const stages: StageAction[][] = [];
  // group ranges split by decouplers, top → bottom
  const groups: Array<{ from: number; to: number; decoupler: CraftSlot | null }> = [];
  let start = 0;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].def.type === 'decoupler') {
      groups.push({ from: start, to: i - 1, decoupler: slots[i] });
      start = i + 1;
    }
  }
  groups.push({ from: start, to: slots.length - 1, decoupler: null });

  // walk groups bottom → top
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    const ignite: StageAction[] = [];
    const jettison: StageAction[] = [];
    for (let i = g.from; i <= g.to && i < slots.length; i++) {
      const s = slots[i];
      if (s.def.type === 'engine' || s.def.type === 'srb') {
        ignite.push({ kind: 'ignite', uid: s.uid });
      }
      for (const r of s.radials) {
        if (r.def.type === 'srb') {
          ignite.push({ kind: 'ignite', uid: r.uid });
          jettison.push({ kind: 'jettison', uid: r.uid });
        }
      }
    }
    if (gi === groups.length - 1) {
      if (ignite.length) stages.push(ignite);
    } else {
      // this group ignites TOGETHER with dropping the spent group below it;
      // g.decoupler sits at the bottom of group gi and severs everything under it
      const d = g.decoupler;
      const stage: StageAction[] = d ? [{ kind: 'decouple', uid: d.uid }] : [];
      stage.push(...ignite);
      if (stage.length) stages.push(stage);
    }
    if (jettison.length) stages.push(jettison);
  }

  // parachutes arm last, all together
  const chutes: StageAction[] = [];
  for (const s of slots) {
    if (s.def.type === 'parachute') chutes.push({ kind: 'chute', uid: s.uid });
    for (const r of s.radials) {
      if (r.def.type === 'parachute') chutes.push({ kind: 'chute', uid: r.uid });
    }
  }
  if (chutes.length) stages.push(chutes);
  return stages;
}

const keyOf = (a: StageAction) => `${a.kind}:${a.uid}`;

/**
 * After any structural edit: drop actions whose parts are gone, keep the
 * user's arrangement for surviving parts, and slot newly-required actions
 * where the default generator would put them.
 */
export function reconcileStages(design: CraftDesign): void {
  const required = requiredActions(design.slots);
  const requiredKeys = new Set(required.map(keyOf));
  const present = new Set<string>();
  // strip dead / duplicate actions
  for (const stage of design.stages) {
    for (let i = stage.length - 1; i >= 0; i--) {
      const k = keyOf(stage[i]);
      if (!requiredKeys.has(k) || present.has(k)) stage.splice(i, 1);
      else present.add(k);
    }
  }
  design.stages = design.stages.filter((s) => s.length > 0);
  // insert missing actions at their default positions
  const missing = required.filter((a) => !present.has(keyOf(a)));
  if (missing.length === 0) return;
  const defaults = defaultStages(design.slots);
  for (const a of missing) {
    const k = keyOf(a);
    const defIdx = defaults.findIndex((st) => st.some((x) => keyOf(x) === k));
    // find the stage that shares most members with that default stage
    let bestStage: StageAction[] | null = null;
    let bestScore = 0;
    if (defIdx >= 0) {
      const wantKeys = new Set(defaults[defIdx].map(keyOf));
      for (const st of design.stages) {
        const score = st.filter((x) => wantKeys.has(keyOf(x))).length;
        if (score > bestScore) {
          bestScore = score;
          bestStage = st;
        }
      }
    }
    if (bestStage) bestStage.push(a);
    else design.stages.push([a]);
  }
}

/** Look up what an action's uid refers to (slot or radial group). */
export function findByUid(
  slots: CraftSlot[],
  uid: number,
): { slot: CraftSlot; radial: RadialGroup | null; index: number } | null {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].uid === uid) return { slot: slots[i], radial: null, index: i };
    for (const r of slots[i].radials) {
      if (r.uid === uid) return { slot: slots[i], radial: r, index: i };
    }
  }
  return null;
}

/** Short human label for a stage-editor chip. */
export function actionLabel(slots: CraftSlot[], a: StageAction): string {
  const hit = findByUid(slots, a.uid);
  if (!hit) return '?';
  const def = hit.radial ? hit.radial.def : hit.slot.def;
  const short = def.name.replace(/^[A-Z]+-\d+\s*/, '').replace(/".*?"\s*/, '');
  const n = hit.radial && hit.radial.count > 1 ? `${hit.radial.count}× ` : '';
  switch (a.kind) {
    case 'ignite':
      return `🔥 ${n}${short}`;
    case 'decouple':
      return `✂ Decouple`;
    case 'jettison':
      return `⤢ Drop ${n}booster`;
    case 'chute':
      return `☂ ${n}chute`;
  }
}
