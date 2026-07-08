import * as THREE from 'three';
import { AUDIO } from '../audio';
import { GameHost, GameScene } from '../host';
import { buildCampus } from '../render/campus';
import { buildRocketVisual } from '../render/rocketMesh';
import { STATE } from '../state';
import { HOME } from '../universe/bodies';
import { PAD_DIR } from '../universe/terrain';
import { $, fmtDist, fmtTime } from '../util/format';

/**
 * The Zenith Space Center: a ground-level hub on the launch plateau with
 * the pad, the VAB building, and the tracking station. Doorway to the
 * other screens; time keeps flowing while you're here.
 */
export class SpaceCenterScene implements GameScene {
  private host: GameHost;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);
  private sun: THREE.DirectionalLight;
  private yaw = 0.7;
  private zoom = 1;
  private dragging = false;
  private lastX = 0;
  private autoSpin = true;
  private bound = false;
  private trackTimer = 0;
  private padVisual: THREE.Group | null = null;
  private padSig = '';

  private onPointerDown = (e: PointerEvent) => {
    this.dragging = true;
    this.autoSpin = false;
    this.lastX = e.clientX;
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.yaw += (e.clientX - this.lastX) * 0.006;
    this.lastX = e.clientX;
  };
  private onPointerUp = () => (this.dragging = false);
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom = THREE.MathUtils.clamp(this.zoom * Math.pow(1.1, e.deltaY * 0.01), 0.5, 2.2);
  };

  constructor(host: GameHost) {
    this.host = host;
    this.scene.background = new THREE.Color(0x6fa4d8);
    this.scene.fog = new THREE.Fog(0x88b4d8, 300, 1800);

    // The plateau
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(900, 64),
      new THREE.MeshStandardMaterial({ color: 0x39683f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Pad + buildings + floodlights (shared with the flight scene)
    this.scene.add(buildCampus());

    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x9fb4d0, 0.55));
    this.onResize();
  }

  enter(): void {
    $('sc-ui').classList.remove('hidden');
    AUDIO.playMusic('dunes');
    if (!this.bound) {
      this.bound = true;
      $('sc-vab').addEventListener('click', () => this.host.toVAB());
      $('sc-track').addEventListener('click', () => {
        $('tracking-panel').classList.toggle('hidden');
        this.refreshTracking();
      });
      $('tracking-close').addEventListener('click', () =>
        $('tracking-panel').classList.add('hidden'),
      );
    }
    const canvas = this.host.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.refreshTracking();
    this.updatePadVessel();
  }

  /** If a vessel is parked on the pad, show it standing there. */
  private updatePadVessel(): void {
    const occ = STATE.vessels.find(
      (v) =>
        v.landed &&
        !v.destroyed &&
        v.body === HOME &&
        v.landedDir.angleTo(PAD_DIR) < 0.01,
    );
    const sig = occ ? `${occ.name}:${occ.parts.length}:${occ.deployedChutes()}` : '';
    if (sig === this.padSig) return;
    this.padSig = sig;
    if (this.padVisual) {
      this.scene.remove(this.padVisual);
      this.padVisual = null;
    }
    if (occ) {
      const { group, height } = buildRocketVisual(occ.parts, occ.radials);
      group.position.set(0, 2.4 + height / 2, 0);
      this.scene.add(group);
      this.padVisual = group;
    }
  }

  exit(): void {
    $('sc-ui').classList.add('hidden');
    $('tracking-panel').classList.add('hidden');
    $('pause-menu').classList.add('hidden');
    const canvas = this.host.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      const p = $('pause-menu');
      const show = p.classList.contains('hidden');
      p.classList.toggle('hidden', !show);
      if (show) {
        $('pause-ut').textContent = `UT ${fmtTime(STATE.t)}`;
        $('pause-resume').onclick = () => p.classList.add('hidden');
        for (const id of [
          'pause-revert',
          'pause-recover',
          'pause-tovab',
          'pause-terminate',
          'pause-sc',
        ]) {
          $(id).style.display = 'none';
        }
      }
    }
  }

  onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Vessel list for the tracking station. */
  private refreshTracking(): void {
    const list = $('tracking-list');
    list.innerHTML = '';
    if (STATE.vessels.length === 0) {
      list.innerHTML =
        '<div class="stack-empty">Nothing in flight — the sky is patient.</div>';
      return;
    }
    for (const v of STATE.vessels) {
      const row = document.createElement('div');
      row.className = 'mission-row';
      const status = v.destroyed
        ? `<span class="lost">LOST · ${v.body.name}</span>`
        : v.landed
          ? `landed · ${v.body.name}`
          : `${v.body.name} · ${fmtDist(v.pos.length() - v.body.radius)}`;
      const info = document.createElement('div');
      info.innerHTML = `${v.name}<small>${status}</small>`;
      row.appendChild(info);
      const btn = document.createElement('button');
      btn.className = 'btn' + (v.destroyed ? ' danger' : '');
      btn.textContent = v.destroyed ? '✕' : 'FLY';
      btn.addEventListener('click', () => {
        if (v.destroyed) {
          STATE.remove(v);
          this.refreshTracking();
        } else {
          this.host.flyVessel(v);
        }
      });
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  update(dt: number): void {
    // the world keeps turning at the space center
    STATE.t += dt;
    STATE.advanceInactive(dt, null);
    this.trackTimer += dt;
    if (this.trackTimer > 1) {
      this.trackTimer = 0;
      if (!$('tracking-panel').classList.contains('hidden')) this.refreshTracking();
      this.updatePadVessel();
      $('sc-info').textContent =
        `UT ${fmtTime(STATE.t)} · ${STATE.mode === 'freedom' ? 'SANDBOX' : `✦ ${STATE.science}`} · ${STATE.vessels.length} in flight`;
    }

    // Sunlight from the actual sun position over the pad (dawn at UT 0)
    const theta = HOME.rotationAngle(STATE.t);
    const east = new THREE.Vector3(0, 1, 0).cross(PAD_DIR.clone()).normalize();
    // local sun elevation/azimuth at the pad
    const sunLocal = new THREE.Vector3(-1, 0, 0); // toward Helios at t≈0 (world)
    const up = PAD_DIR.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), theta);
    const eastW = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    const northW = up.clone().cross(eastW);
    const elev = sunLocal.dot(up);
    const eastC = sunLocal.dot(eastW);
    const northC = sunLocal.dot(northW);
    this.sun.position
      .set(eastC * 300, Math.max(elev, -0.2) * 300, northC * 300)
      .add(new THREE.Vector3(0, 20, 0));
    this.sun.intensity = THREE.MathUtils.clamp(1.4 + elev * 2, 0.1, 2.4);
    const day = THREE.MathUtils.clamp(elev * 2.4 + 0.55, 0.06, 1);
    (this.scene.background as THREE.Color).setRGB(0.43 * day, 0.64 * day, 0.85 * day);
    void east;

    if (this.autoSpin) this.yaw += dt * 0.05;
    const dist = 170 * this.zoom;
    this.camera.position.set(
      Math.sin(this.yaw) * dist - 40,
      58 * this.zoom + 12,
      Math.cos(this.yaw) * dist + 10,
    );
    this.camera.lookAt(-45, 16, 5);
    this.host.renderer.render(this.scene, this.camera);
  }
}
