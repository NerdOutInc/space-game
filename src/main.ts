import * as THREE from 'three';
import './style.css';
import { GameHost, GameScene } from './host';
import { FlightScene } from './scenes/flight';
import { VABScene } from './scenes/vab';
import { PartDef } from './vessel/parts';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

class Game implements GameHost {
  renderer: THREE.WebGLRenderer;
  keys = new Set<string>();
  private scene: GameScene | null = null;
  private vab: VABScene;
  private clock = new THREE.Clock();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.vab = new VABScene(this);

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.scene?.onResize?.();
    });
    window.addEventListener('keydown', (e) => {
      // don't hijack browser shortcuts
      if (e.metaKey) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
      this.keys.add(e.code);
      this.scene?.onKeyDown?.(e);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private switchTo(scene: GameScene): void {
    this.scene?.exit();
    this.scene = scene;
    scene.onResize?.();
    scene.enter();
  }

  toVAB(): void {
    this.switchTo(this.vab);
  }

  toFlight(defs: PartDef[]): void {
    this.switchTo(new FlightScene(this, defs));
  }

  start(): void {
    this.toVAB();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.scene?.update(dt);
    };
    loop();
  }
}

new Game().start();
