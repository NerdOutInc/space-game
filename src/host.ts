import * as THREE from 'three';
import { PartDef } from './vessel/parts';

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
  toFlight(defs: PartDef[]): void;
}
