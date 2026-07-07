import * as THREE from 'three';
import { PartDef } from './vessel/parts';
import { Vessel } from './vessel/vessel';

export interface GameScene {
  enter(): void;
  exit(): void;
  update(dt: number): void;
  onKeyDown?(e: KeyboardEvent): void;
  onResize?(): void;
}

export interface GameHost {
  renderer: THREE.WebGLRenderer;
  keys: Set<string>;
  toVAB(): void;
  /** Build a new vessel from part defs, add it to the world, and fly it. */
  launchVessel(defs: PartDef[]): void;
  /** Switch focus to an existing vessel. */
  flyVessel(vessel: Vessel): void;
  /** Reset a vessel to a fresh copy on the pad and fly it. */
  revertVessel(vessel: Vessel): void;
  /** Remove a (landed) vessel from the world and return to the VAB. */
  recoverVessel(vessel: Vessel): void;
  /** Remove a vessel (terminate/destroyed cleanup) and return to the VAB. */
  removeVessel(vessel: Vessel): void;
}
