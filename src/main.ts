import * as THREE from 'three';
import './style.css';
import { AUDIO } from './audio';
import { GameHost, GameScene } from './host';
import { FlightScene } from './scenes/flight';
import { MenuScene } from './scenes/menu';
import { VABScene } from './scenes/vab';
import { STATE } from './state';
import { HOME } from './universe/bodies';
import { showToast } from './util/toast';
import { CraftPart } from './vessel/parts';
import { Vessel } from './vessel/vessel';

STATE.loadLatest();

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
    // Autosave: periodically and when the tab closes
    setInterval(() => STATE.save(), 20_000);
    window.addEventListener('beforeunload', () => STATE.save());
  }

  private switchTo(scene: GameScene): void {
    this.scene?.exit();
    this.scene = scene;
    scene.onResize?.();
    scene.enter();
    STATE.save();
  }

  toVAB(): void {
    this.switchTo(this.vab);
  }

  launchVessel(craft: CraftPart[]): void {
    const vessel = new Vessel(craft, HOME);
    vessel.name = STATE.nextName();
    STATE.add(vessel);
    this.switchTo(new FlightScene(this, vessel));
  }

  flyVessel(vessel: Vessel): void {
    this.switchTo(new FlightScene(this, vessel));
  }

  revertVessel(vessel: Vessel): void {
    const fresh = new Vessel(vessel.craft, HOME);
    fresh.name = vessel.name;
    STATE.replace(vessel, fresh);
    this.switchTo(new FlightScene(this, fresh));
  }

  recoverVessel(vessel: Vessel): void {
    const bonus = vessel.reachedSpace ? STATE.award('recover') : null;
    STATE.remove(vessel);
    this.toVAB();
    if (bonus) showToast(bonus);
    showToast(`${vessel.name} recovered`);
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
      // Test hooks: synchronously advance the game; poke the world state.
      const w = window as unknown as {
        __step?: (sec: number) => void;
        __state?: typeof STATE;
      };
      w.__step = (sec) => {
        const n = Math.ceil(sec / 0.05);
        for (let i = 0; i < n; i++) this.scene?.update(0.05);
      };
      w.__state = STATE;
    }
  }
}

new Game().start();
