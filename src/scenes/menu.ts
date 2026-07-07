import * as THREE from 'three';
import { AUDIO } from '../audio';
import { GameHost, GameScene } from '../host';
import { makeAtmosphereMaterial } from '../render/atmosphere';
import { makeBodyTexture, makeStarfield } from '../render/textures';
import { STATE } from '../state';
import { GAIA, LUNA } from '../universe/bodies';
import { terrainHeight } from '../universe/terrain';
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

    // Unit-scale Gaia with proportionally exaggerated terrain so the land
    // rises through the water layer even at menu scale.
    const geo = new THREE.SphereGeometry(1, 128, 64);
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
    const dir = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      dir.fromBufferAttribute(posAttr, i).normalize();
      const h = terrainHeight(GAIA, dir);
      dir.multiplyScalar(1 + (h / GAIA.radius) * 3); // 3× exaggeration for looks
      posAttr.setXYZ(i, dir.x, dir.y, dir.z);
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
    this.gaia = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: makeBodyTexture(GAIA), roughness: 1 }),
    );
    // Menu planet is unit-scale; keep the atmosphere hugging the surface.
    const a = GAIA.atmosphere!;
    const shellScale = 1 + (a.height * 2) / GAIA.radius;
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(shellScale, 96, 48),
      makeAtmosphereMaterial(
        a.skyColor.clone(),
        1,
        shellScale,
        (a.height * 0.8) / GAIA.radius,
        0.85,
      ),
    );
    this.gaia.add(shell);
    // water surface over the seabed texture
    const water = new THREE.Mesh(
      new THREE.SphereGeometry(1.001, 96, 48),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(GAIA.color).multiplyScalar(0.85),
        transparent: true,
        opacity: 0.62,
        roughness: 0.12,
        metalness: 0.05,
        depthWrite: false,
      }),
    );
    this.gaia.add(water);
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

  private choosingMode = false;

  enter(): void {
    $('menu-ui').classList.remove('hidden');
    AUDIO.playMusic('cosmic');
    AUDIO.syncSliders('vol-music', 'vol-sfx');
    this.choosingMode = !STATE.hasSave();
    this.refreshButtons();
    if (!this.bound) {
      this.bound = true;
      $('menu-start').addEventListener('click', () => {
        AUDIO.unlock();
        if (this.choosingMode) STATE.reset('science');
        this.host.toVAB();
      });
      $('menu-free').addEventListener('click', () => {
        AUDIO.unlock();
        STATE.reset('freedom');
        this.host.toVAB();
      });
      $('menu-new').addEventListener('click', () => {
        this.choosingMode = true;
        this.refreshButtons();
      });
      AUDIO.bindSliders('vol-music', 'vol-sfx');
    }
  }

  /** CONTINUE + NEW GAME when a save exists; the two mode buttons otherwise. */
  private refreshButtons(): void {
    if (this.choosingMode) {
      $('menu-start').innerHTML = '▲ &nbsp;SCIENCE MODE';
      $('menu-free').classList.remove('hidden');
      $('menu-new').classList.add('hidden');
    } else {
      $('menu-start').innerHTML = '▲ &nbsp;CONTINUE';
      $('menu-free').classList.add('hidden');
      $('menu-new').classList.remove('hidden');
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
