import * as THREE from 'three';
import { AUDIO } from '../audio';
import { GameHost, GameScene } from '../host';
import { makeAtmosphereMaterial } from '../render/atmosphere';
import { makeBodyTexture, makeStarfield } from '../render/textures';
import { GAIA, LUNA } from '../universe/bodies';
import { $ } from '../util/format';

/** Title screen: Gaia turning slowly under the stars. */
export class MenuScene implements GameScene {
  private host: GameHost;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  private gaia: THREE.Mesh;
  private luna: THREE.Mesh;
  private t = 0;
  private bound = false;

  constructor(host: GameHost) {
    this.host = host;
    this.scene.background = new THREE.Color(0x000004);
    this.scene.add(makeStarfield(60, 1800));

    this.gaia = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 48),
      new THREE.MeshStandardMaterial({ map: makeBodyTexture(GAIA), roughness: 1 }),
    );
    // Menu planet is unit-scale; size the atmosphere shell proportionally.
    const shellScale = 1 + (GAIA.atmosphere!.height * 1.4) / GAIA.radius;
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(shellScale, 96, 48),
      makeAtmosphereMaterial(GAIA.atmosphere!.skyColor.clone(), 0.9),
    );
    this.gaia.add(shell);
    this.gaia.position.set(1.15, -0.25, 0);
    this.scene.add(this.gaia);

    this.luna = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 48, 24),
      new THREE.MeshStandardMaterial({ map: makeBodyTexture(LUNA), roughness: 1 }),
    );
    this.scene.add(this.luna);

    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sun.position.set(-4, 1.5, 3);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x445577, 0.35));

    this.camera.position.set(0, 0, 3.4);
    this.camera.lookAt(0.6, 0, 0);
    this.onResize();
  }

  enter(): void {
    $('menu-ui').classList.remove('hidden');
    AUDIO.playMusic('cosmic');
    AUDIO.syncSliders('vol-music', 'vol-sfx');
    if (!this.bound) {
      this.bound = true;
      $('menu-start').addEventListener('click', () => {
        AUDIO.unlock();
        this.host.toVAB();
      });
      AUDIO.bindSliders('vol-music', 'vol-sfx');
    }
  }

  exit(): void {
    $('menu-ui').classList.add('hidden');
  }

  onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    this.t += dt;
    this.gaia.rotation.y += dt * 0.04;
    const a = this.t * 0.11 + 2.2;
    this.luna.position.set(
      this.gaia.position.x + Math.cos(a) * 2.4,
      this.gaia.position.y + 0.35,
      this.gaia.position.z - Math.sin(a) * 1.4,
    );
    this.host.renderer.render(this.scene, this.camera);
  }
}
