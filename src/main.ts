import * as THREE from 'three';
import './style.css';
import { AUDIO } from './audio';
import { GameHost, GameScene } from './host';
import { FlightScene } from './scenes/flight';
import { MenuScene } from './scenes/menu';
import { VABScene } from './scenes/vab';
import { STATE } from './state';
import { HOME } from './universe/bodies';
import { PartDef } from './vessel/parts';
import { Vessel } from './vessel/vessel';

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
    // Audio contexts need a user gesture before they can make sound.
    const unlock = () => AUDIO.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    AUDIO.bindSliders('pv-music', 'pv-sfx');
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

  launchVessel(defs: PartDef[]): void {
    const vessel = new Vessel(defs, HOME);
    vessel.name = STATE.nextName();
    STATE.add(vessel);
    this.switchTo(new FlightScene(this, vessel));
  }

  flyVessel(vessel: Vessel): void {
    this.switchTo(new FlightScene(this, vessel));
  }

  revertVessel(vessel: Vessel): void {
    const fresh = new Vessel(vessel.defs, HOME);
    fresh.name = vessel.name;
    STATE.replace(vessel, fresh);
    this.switchTo(new FlightScene(this, fresh));
  }

  recoverVessel(vessel: Vessel): void {
    STATE.remove(vessel);
    this.toVAB();
  }

  removeVessel(vessel: Vessel): void {
    STATE.remove(vessel);
    this.toVAB();
  }

  start(): void {
    this.switchTo(new MenuScene(this));
    let lastStep = performance.now();
    const step = () => {
      lastStep = performance.now();
      // Cover real elapsed time (up to 2 s) — scenes chunk physics internally,
      // so a throttled background tab still simulates at full speed.
      const dt = Math.min(this.clock.getDelta(), 2);
      this.scene?.update(dt);
    };
    const loop = () => {
      requestAnimationFrame(loop);
      step();
    };
    loop();
    // Browsers throttle rAF to zero in hidden/occluded windows; keep the
    // simulation ticking (at reduced rate) from a timer so flights continue.
    setInterval(() => {
      if (performance.now() - lastStep > 90) step();
    }, 30);
    if (import.meta.env.DEV) {
      // Test hook: synchronously advance the game by `sec` seconds.
      (window as unknown as { __step?: (sec: number) => void }).__step = (sec) => {
        const n = Math.ceil(sec / 0.05);
        for (let i = 0; i < n; i++) this.scene?.update(0.05);
      };
    }
  }
}

new Game().start();
