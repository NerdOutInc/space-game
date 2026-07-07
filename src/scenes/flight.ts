import * as THREE from 'three';
import { AUDIO } from '../audio';
import { GameHost, GameScene } from '../host';
import { orbitalElements, sampleOrbit } from '../math/kepler';
import { addAtmosphereShell } from '../render/atmosphere';
import { Navball } from '../render/navball';
import { buildFlame, buildRocketVisual } from '../render/rocketMesh';
import { makeBodyTexture, makeDotTexture, makeStarfield } from '../render/textures';
import { Controls, Simulation } from '../sim/simulation';
import { STATE } from '../state';
import { BODIES, Body, HELIOS, HOME } from '../universe/bodies';
import { displacePlanetGeometry, groundHeight, PAD_DIR } from '../universe/terrain';
import { $, fmtDist, fmtSpeed, fmtTime } from '../util/format';
import { showToast } from '../util/toast';
import { BoosterInstance, Vessel } from '../vessel/vessel';
import { makeAtmosphereMaterial } from '../render/atmosphere';

const MAP_SCALE = 1e-6; // meters → map units

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _spin = new THREE.Vector3();

interface Debris {
  group: THREE.Group;
  body: Body;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
}

interface MapBodyVis {
  mesh: THREE.Mesh;
  marker: THREE.Sprite;
  orbit: THREE.Line | null;
  label: HTMLElement;
}

interface OtherVesselVis {
  vessel: Vessel;
  marker: THREE.Sprite;
  label: HTMLElement;
}

export class FlightScene implements GameScene {
  private host: GameHost;
  private vessel: Vessel;
  private sim: Simulation;
  private navball = new Navball();
  private paused = false;

  // -- flight view --
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.3, 1e12);
  private camYaw = 0.4;
  private camPitch = 0.18;
  private camDist = 26;
  private bodyMeshes = new Map<Body, THREE.Mesh>();
  private stars: THREE.Points;
  private sunLight: THREE.DirectionalLight;
  private rocketHolder = new THREE.Group();
  private flame: THREE.Mesh;
  private boosterFlames: THREE.Mesh[] = [];
  private rocketHeight = 0;
  private lastChutes = 0;
  private pad: THREE.Mesh;
  private debris: Debris[] = [];
  /** Nearby vessels rendered in the flight view (docking partners etc.). */
  private nearby = new Map<Vessel, { group: THREE.Group; sig: number }>();

  // -- map view --
  private mapScene = new THREE.Scene();
  private mapCamera = new THREE.PerspectiveCamera(55, 1, 0.001, 5e5);
  private mapYaw = 0.6;
  private mapPitch = 1.15;
  private mapDist = 30;
  private mapBodies = new Map<Body, MapBodyVis>();
  private vesselMarker: THREE.Sprite;
  private vesselLabel: HTMLElement;
  private others: OtherVesselVis[] = [];
  private orbitLine: THREE.Line;
  private orbitGeo: THREE.BufferGeometry;
  private apMarker: THREE.Sprite;
  private peMarker: THREE.Sprite;
  private apLabel: HTMLElement;
  private peLabel: HTMLElement;

  private mode: 'flight' | 'map' = 'flight';
  private endShown = false;
  private static debugPhase = 0;

  // bound listeners for cleanup
  private onPointerDown = (e: PointerEvent) => this.pointerDown(e);
  private onPointerMove = (e: PointerEvent) => this.pointerMove(e);
  private onPointerUp = () => (this.dragging = false);
  private onWheel = (e: WheelEvent) => this.wheel(e);
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(host: GameHost, vessel: Vessel) {
    this.host = host;
    this.vessel = vessel;
    this.sim = new Simulation(vessel, STATE);

    // ---------- flight scene ----------
    this.scene.background = new THREE.Color(0x000004);
    this.stars = makeStarfield(9e6);
    this.scene.add(this.stars);

    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.scene.add(new THREE.AmbientLight(0x8899bb, 0.35));

    for (const body of BODIES) {
      let mesh: THREE.Mesh;
      if (body.isStar) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(body.radius, 48, 24),
          new THREE.MeshBasicMaterial({ color: body.color }),
        );
      } else {
        const geo = new THREE.SphereGeometry(body.radius, 192, 96);
        displacePlanetGeometry(geo, body);
        mesh = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            map: makeBodyTexture(body),
            roughness: 1,
            metalness: 0,
          }),
        );
        if (body.terrain?.ocean) {
          // Translucent water surface at the datum; the displaced seabed
          // below shows through, so depth reads naturally near coasts.
          const water = new THREE.Mesh(
            new THREE.SphereGeometry(body.radius + 2, 128, 64),
            new THREE.MeshStandardMaterial({
              color: new THREE.Color(body.color).multiplyScalar(0.85),
              transparent: true,
              opacity: 0.62,
              roughness: 0.12,
              metalness: 0.05,
              depthWrite: false,
            }),
          );
          mesh.add(water);
        }
        addAtmosphereShell(mesh, body);
      }
      this.bodyMeshes.set(body, mesh);
      this.scene.add(mesh);
    }

    this.flame = buildFlame();
    this.scene.add(this.rocketHolder);
    this.rebuildRocket();

    this.pad = new THREE.Mesh(
      new THREE.CylinderGeometry(7, 8, 1.2, 24),
      new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.85 }),
    );
    this.scene.add(this.pad);

    // ---------- map scene ----------
    const dot = makeDotTexture();
    const labels = $('map-labels');
    labels.innerHTML = '';

    for (const body of BODIES) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(body.radius * MAP_SCALE, 0.02), 32, 16),
        new THREE.MeshBasicMaterial({ color: body.color }),
      );
      if (body.atmosphere) {
        // Soft haze fading from the surface outward (same shader as flight view)
        const planetR = body.radius * MAP_SCALE;
        const shellR = (body.radius + body.atmosphere.height * 4) * MAP_SCALE;
        const haze = new THREE.Mesh(
          new THREE.SphereGeometry(shellR, 48, 24),
          makeAtmosphereMaterial(
            body.atmosphere.skyColor.clone(),
            planetR,
            shellR,
            body.atmosphere.height * 1.3 * MAP_SCALE,
            0.85,
          ),
        );
        mesh.add(haze);
        // Faint ring at the exact edge of drag, for flight planning
        const atmoR = (body.radius + body.atmosphere.height) * MAP_SCALE;
        const ringPts: THREE.Vector3[] = [];
        for (let i = 0; i <= 96; i++) {
          const a = (i / 96) * Math.PI * 2;
          ringPts.push(new THREE.Vector3(Math.cos(a) * atmoR, 0, Math.sin(a) * atmoR));
        }
        const ring = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(ringPts),
          new THREE.LineBasicMaterial({
            color: body.atmosphere.skyColor,
            transparent: true,
            opacity: 0.22,
          }),
        );
        mesh.add(ring);
      }
      this.mapScene.add(mesh);
      const marker = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: dot, color: body.color, depthTest: false }),
      );
      this.mapScene.add(marker);
      let orbit: THREE.Line | null = null;
      if (body.parent) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 128; i++) {
          const a = (i / 128) * Math.PI * 2;
          pts.push(
            new THREE.Vector3(
              Math.cos(a) * body.orbitRadius * MAP_SCALE,
              0,
              -Math.sin(a) * body.orbitRadius * MAP_SCALE,
            ),
          );
        }
        orbit = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: body.color, transparent: true, opacity: 0.45 }),
        );
        this.mapScene.add(orbit);
      }
      const label = document.createElement('div');
      label.className = 'map-label';
      label.textContent = body.name;
      labels.appendChild(label);
      this.mapBodies.set(body, { mesh, marker, orbit, label });
    }

    this.vesselMarker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: dot, color: 0x7dffa8, depthTest: false }),
    );
    this.mapScene.add(this.vesselMarker);
    this.vesselLabel = document.createElement('div');
    this.vesselLabel.className = 'map-label marker-label';
    this.vesselLabel.textContent = `● ${vessel.name}`;
    labels.appendChild(this.vesselLabel);

    // Other vessels in the world show up as gray markers in the map.
    for (const other of STATE.vessels) {
      if (other === vessel) continue;
      const marker = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: dot, color: 0xb9c4cf, depthTest: false }),
      );
      marker.visible = false;
      this.mapScene.add(marker);
      const label = document.createElement('div');
      label.className = 'map-label';
      label.textContent = other.name;
      labels.appendChild(label);
      this.others.push({ vessel: other, marker, label });
    }

    this.orbitGeo = new THREE.BufferGeometry();
    this.orbitGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(600 * 3), 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    this.orbitLine = new THREE.Line(
      this.orbitGeo,
      new THREE.LineBasicMaterial({ color: 0x7dffa8 }),
    );
    this.orbitLine.frustumCulled = false;
    this.mapScene.add(this.orbitLine);

    this.apMarker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: dot, color: 0x7fd4ff, depthTest: false }),
    );
    this.peMarker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: dot, color: 0xffb35c, depthTest: false }),
    );
    this.mapScene.add(this.apMarker, this.peMarker);
    this.apLabel = document.createElement('div');
    this.apLabel.className = 'map-label marker-label';
    this.peLabel = document.createElement('div');
    this.peLabel.className = 'map-label marker-label';
    labels.appendChild(this.apLabel);
    labels.appendChild(this.peLabel);

    this.onResize();
  }

  // ---------------- lifecycle ----------------

  enter(): void {
    $('flight-ui').classList.remove('hidden');
    $('end-dialog').classList.add('hidden');
    const canvas = this.host.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });

    $('btn-stage').onclick = () => this.doStage();
    $('btn-map').onclick = () => this.toggleMap();
    $('btn-warp-up').onclick = () => this.warp(1);
    $('btn-warp-down').onclick = () => this.warp(-1);
    $('btn-ap').onclick = () => this.toggleAutopilot();
    $('btn-transfer').onclick = () => this.engageProgram('transfer');
    $('btn-rdv').onclick = () => this.engageProgram('rendezvous');
    $('btn-dock').onclick = () => this.engageProgram('dock');
    $('end-revert').onclick = () => this.host.revertVessel(this.vessel);
    $('end-vab').onclick = () => this.host.removeVessel(this.vessel);
    $('map-labels').style.display = 'none';
    $('map-info').classList.add('hidden');
    AUDIO.playMusic('cosmic');

    // Debug panel (toggle with `)
    const sel = $('debug-body') as HTMLSelectElement;
    if (sel.options.length === 0) {
      for (const b of BODIES) {
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = b.name;
        if (b.name === 'Luna') opt.selected = true;
        sel.appendChild(opt);
      }
    }
    $('debug-set').onclick = () => this.debugSetOrbit();
    $('debug-panel').classList.add('hidden');
    if (this.vessel.launchedAt === null) {
      this.toast(`${this.vessel.name} on the pad — SPACE to ignite, or G for autopilot`);
    } else {
      this.toast(`Now flying ${this.vessel.name}`);
    }
  }

  exit(): void {
    $('flight-ui').classList.add('hidden');
    const canvas = this.host.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
    $('map-labels').innerHTML = '';
    $('pause-menu').classList.add('hidden');
    AUDIO.setEngineLevel(0);
    AUDIO.setChuteLevel(0);
    this.navball.dispose();
    // This scene is per-flight: free GPU resources when leaving it.
    for (const scene of [this.scene, this.mapScene]) {
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (!m) continue;
          const std = m as THREE.MeshStandardMaterial;
          std.map?.dispose();
          m.dispose();
        }
      });
    }
  }

  onResize(): void {
    const a = window.innerWidth / window.innerHeight;
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
    this.mapCamera.aspect = a;
    this.mapCamera.updateProjectionMatrix();
  }

  // ---------------- input ----------------

  private pointerDown(e: PointerEvent): void {
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const dx = (e.clientX - this.lastX) * 0.006;
    const dy = (e.clientY - this.lastY) * 0.006;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.mode === 'flight') {
      this.camYaw -= dx;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy, -1.35, 1.35);
    } else {
      this.mapYaw -= dx;
      this.mapPitch = THREE.MathUtils.clamp(this.mapPitch + dy, -1.45, 1.45);
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const f = Math.pow(1.1, e.deltaY * 0.01);
    if (this.mode === 'flight') {
      this.camDist = THREE.MathUtils.clamp(this.camDist * f, 8, 4000);
    } else {
      this.mapDist = THREE.MathUtils.clamp(this.mapDist * f, 0.4, 60000);
    }
  }

  onKeyDown(e: KeyboardEvent): void {
    if (this.paused) {
      if (e.code === 'Escape') this.setPaused(false);
      return;
    }
    switch (e.code) {
      case 'Space':
        this.doStage();
        break;
      case 'KeyM':
        this.toggleMap();
        break;
      case 'Comma':
        this.warp(-1);
        break;
      case 'Period':
        this.warp(1);
        break;
      case 'KeyT':
        this.vessel.sas = !this.vessel.sas;
        this.toast(this.vessel.sas ? 'SAS on' : 'SAS off');
        break;
      case 'KeyZ':
        this.vessel.throttle = 1;
        break;
      case 'KeyX':
        this.vessel.throttle = 0;
        break;
      case 'KeyP':
        this.deployChute();
        break;
      case 'KeyG':
        this.toggleAutopilot();
        break;
      case 'KeyU': {
        const msg = this.sim.undock();
        if (msg) this.toast(msg);
        break;
      }
      case 'KeyR':
        this.host.revertVessel(this.vessel);
        break;
      case 'Backquote':
        $('debug-panel').classList.toggle('hidden');
        break;
      case 'Escape':
        this.setPaused(true);
        break;
    }
  }

  /** Debug tool: teleport the vessel into a circular orbit of any body. */
  private debugSetOrbit(): void {
    const v = this.vessel;
    const sel = $('debug-body') as HTMLSelectElement;
    const body = BODIES.find((b) => b.name === sel.value) ?? HOME;
    const input = $('debug-alt') as HTMLInputElement;
    let alt = parseFloat(input.value) * 1000;
    const minAlt = (body.atmosphere?.height ?? body.maxTerrain) + 10_000;
    if (!isFinite(alt) || alt < minAlt) {
      alt = minAlt;
      input.value = String(Math.round(alt / 1000));
    }
    if (this.sim.autopilot.active) this.sim.autopilot.disengage();
    const r = body.radius + alt;
    v.body = body;
    v.landed = false;
    v.destroyed = false;
    v.throttle = 0;
    // successive placements get different phases, so two debug craft in the
    // same orbit end up separated (handy for rendezvous/docking practice)
    const a = FlightScene.debugPhase++ * 0.25;
    const vc = Math.sqrt(body.mu / r);
    v.pos.set(Math.cos(a) * r, 0, -Math.sin(a) * r);
    v.vel.set(-Math.sin(a) * vc, 0, -Math.cos(a) * vc); // prograde
    v.q.setFromUnitVectors(_v1.set(0, 1, 0), _v2.set(1, 0, 0));
    v.angVel.set(0, 0, 0);
    if (v.launchedAt === null) v.launchedAt = this.sim.t;
    this.sim.warp = 1;
    this.endShown = false;
    $('end-dialog').classList.add('hidden');
    this.toast(`DEBUG: placed in ${Math.round(alt / 1000)} km orbit of ${body.name}`);
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    $('pause-menu').classList.toggle('hidden', !p);
    if (!p) return;
    AUDIO.setEngineLevel(0);
    AUDIO.setChuteLevel(0);
    AUDIO.syncSliders('pv-music', 'pv-sfx');
    $('pause-ut').textContent = `UT ${fmtTime(STATE.t)} · ${this.vessel.name}`;
    $('pause-resume').onclick = () => this.setPaused(false);
    $('pause-revert').onclick = () => this.host.revertVessel(this.vessel);
    $('pause-tovab').onclick = () => this.host.toVAB();
    $('pause-terminate').onclick = () => this.host.removeVessel(this.vessel);
    $('pause-recover').onclick = () => this.host.recoverVessel(this.vessel);
    // Flight pause shows the full set (VAB pause hides these)
    for (const id of ['pause-revert', 'pause-tovab', 'pause-terminate']) {
      $(id).style.display = '';
    }
    const v = this.vessel;
    const recoverable = v.landed && !v.destroyed && v.body === HOME;
    $('pause-recover').style.display = recoverable ? '' : 'none';
  }

  private toggleAutopilot(): void {
    if (this.vessel.destroyed) return;
    const ap = this.sim.autopilot;
    if (ap.active) {
      this.vessel.throttle = 0;
      this.toast(ap.disengage());
      return;
    }
    const input = $('ap-alt') as HTMLInputElement;
    const b = this.vessel.body;
    const minAlt = ((b.atmosphere?.height ?? b.maxTerrain) + 10_000) / 1000;
    let target = parseFloat(input.value);
    if (!isFinite(target) || target < minAlt) {
      target = Math.max(minAlt, 100);
      input.value = String(Math.round(target));
    }
    this.toast(ap.engageAscent(target * 1000));
  }

  /** Engage a targeted autopilot program from the HUD selector. */
  private engageProgram(kind: 'transfer' | 'rendezvous' | 'dock'): void {
    if (this.vessel.destroyed) return;
    const ap = this.sim.autopilot;
    const sel = $('ap-target') as HTMLSelectElement;
    const val = sel.value;
    if (!val) {
      this.toast('Autopilot: no target available here');
      return;
    }
    if (val.startsWith('body:')) {
      if (kind !== 'transfer') {
        this.toast('Autopilot: rendezvous/dock needs a vessel target');
        return;
      }
      const body = BODIES.find((b) => b.name === val.slice(5));
      if (body) this.toast(ap.engageTransfer(this.vessel, body));
      return;
    }
    const name = val.slice(7);
    const target = STATE.vessels.find(
      (x) => x.name === name && x !== this.vessel && !x.destroyed,
    );
    if (!target) {
      this.toast('Autopilot: target vessel not found');
      return;
    }
    if (kind === 'transfer') {
      this.toast('Autopilot: transfers target bodies — use rendezvous for vessels');
      return;
    }
    this.toast(ap.engageRendezvous(this.vessel, target, kind === 'dock'));
  }

  /** Keep the target dropdown in sync with what's actually reachable. */
  private refreshApTargets(): void {
    const sel = $('ap-target') as HTMLSelectElement;
    const v = this.vessel;
    const options: Array<{ value: string; label: string }> = [];
    for (const b of BODIES) {
      if (b.parent === v.body) options.push({ value: `body:${b.name}`, label: `◉ ${b.name}` });
    }
    for (const o of STATE.vessels) {
      if (o !== v && !o.destroyed && !o.landed && o.body === v.body) {
        options.push({ value: `vessel:${o.name}`, label: `⊕ ${o.name}` });
      }
    }
    const sig = options.map((o) => o.value).join('|');
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    if (options.some((o) => o.value === prev)) sel.value = prev;
  }

  private doStage(): void {
    if (this.vessel.destroyed) return;
    this.sim.warp = 1;
    const res = this.vessel.stage();
    this.toast(res.msg);
    if (res.dropped) this.spawnDebris(res.dropped);
    if (res.droppedBoosters) this.spawnBoosterDebris(res.droppedBoosters);
    if (res.dropped || res.droppedBoosters) this.rebuildRocket();
  }

  private warp(dir: 1 | -1): void {
    const msg = this.sim.requestWarp(dir);
    if (msg) this.toast(msg);
  }

  private toggleMap(): void {
    this.mode = this.mode === 'flight' ? 'map' : 'flight';
    $('map-info').classList.toggle('hidden', this.mode !== 'map');
    $('map-labels').style.display = this.mode === 'map' ? 'block' : 'none';
    if (this.mode === 'flight') {
      for (const [, vis] of this.mapBodies) vis.label.style.display = 'none';
    }
  }

  private deployChute(): void {
    const v = this.vessel;
    const alt = v.pos.length() - v.body.radius;
    if (v.landed) return;
    if (!v.body.atmosphere || alt > 40_000) {
      this.toast('Parachute needs atmosphere below 40 km');
      return;
    }
    if (v.deployParachute()) {
      this.toast('Parachute deployed!');
      this.rebuildRocket();
    }
  }

  /** Jettisoned side boosters tumble away sideways. */
  private spawnBoosterDebris(bs: BoosterInstance[]): void {
    bs.forEach((b, i) => {
      const { group } = buildRocketVisual([b]);
      this.scene.add(group);
      const side = _v2
        .set(i % 2 === 0 ? 1 : -1, 0, i >= 2 ? 1 : -1)
        .normalize()
        .applyQuaternion(this.vessel.q);
      const pos = this.vessel.pos.clone().addScaledVector(side, 2);
      const vel = this.vessel.vel.clone().addScaledVector(side, 6);
      group.quaternion.copy(this.vessel.q);
      this.debris.push({ group, body: this.vessel.body, pos, vel, age: 0 });
    });
  }

  private spawnDebris(parts: Vessel['parts']): void {
    const { group } = buildRocketVisual(parts);
    this.scene.add(group);
    const up = _v1.set(0, 1, 0).applyQuaternion(this.vessel.q);
    const droppedH = parts.reduce((s, p) => s + p.def.height, 0);
    const pos = this.vessel.pos
      .clone()
      .addScaledVector(up, -(this.rocketHeight / 2 + droppedH / 2 + 0.5));
    const vel = this.vessel.vel.clone().addScaledVector(up, -2.5);
    group.quaternion.copy(this.vessel.q);
    this.debris.push({ group, body: this.vessel.body, pos, vel, age: 0 });
  }

  private dropNearby(o: Vessel): void {
    const vis = this.nearby.get(o);
    if (!vis) return;
    this.scene.remove(vis.group);
    this.nearby.delete(o);
  }

  private rebuildRocket(): void {
    this.rocketHolder.clear();
    const { group, height, boosterMounts } = buildRocketVisual(this.vessel.parts, [
      ...this.vessel.boosters,
      ...this.vessel.radialChutes,
    ]);
    this.rocketHeight = height;
    this.rocketHolder.add(group);
    this.flame.position.y = -height / 2;
    this.rocketHolder.add(this.flame);
    // one flame per side booster (chute mounts come after boosters in order)
    this.boosterFlames = [];
    for (const m of boosterMounts.slice(0, this.vessel.boosters.length)) {
      const f = buildFlame();
      f.scale.set(0.8, 0.8, 0.8);
      f.position.set(m.x, m.y, m.z);
      f.visible = false;
      this.rocketHolder.add(f);
      this.boosterFlames.push(f);
    }
  }

  // ---------------- per-frame ----------------

  update(dt: number): void {
    const keys = this.host.keys;
    const v = this.vessel;

    if (this.paused) {
      // Frozen physics; camera still responds so you can look around.
      if (this.mode === 'flight') {
        this.syncFlight();
        this.host.renderer.render(this.scene, this.camera);
      } else {
        this.syncMap();
        this.host.renderer.render(this.mapScene, this.mapCamera);
      }
      this.navball.update(v);
      this.navball.render(this.host.renderer);
      return;
    }

    // Continuous inputs
    if (!v.destroyed && !this.sim.autopilot.active) {
      if (keys.has('ShiftLeft') || keys.has('ShiftRight'))
        v.throttle = Math.min(1, v.throttle + dt * 0.6);
      if (keys.has('ControlLeft') || keys.has('ControlRight'))
        v.throttle = Math.max(0, v.throttle - dt * 0.6);
    }
    const ctrl: Controls = {
      pitch: (keys.has('KeyW') ? 1 : 0) + (keys.has('KeyS') ? -1 : 0),
      yaw: (keys.has('KeyA') ? 1 : 0) + (keys.has('KeyD') ? -1 : 0),
      roll: (keys.has('KeyQ') ? 1 : 0) + (keys.has('KeyE') ? -1 : 0),
    };

    const t0 = STATE.t;
    let rem = dt;
    while (rem > 1e-6) {
      const chunk = Math.min(rem, 0.05);
      for (const m of this.sim.step(chunk, ctrl)) this.toast(m);
      rem -= chunk;
    }
    STATE.advanceInactive(STATE.t - t0, v);
    // Docking must see every vessel at the SAME universal time.
    for (const m of this.sim.dockingPass(STATE.t - t0)) this.toast(m);

    // Autopilot staging happens inside the sim — pick up the wreckage.
    const dropped = this.sim.dropped.splice(0);
    const droppedBoosters = this.sim.droppedBoosters.splice(0);
    if (dropped.length > 0 || droppedBoosters.length > 0) {
      for (const parts of dropped) this.spawnDebris(parts);
      for (const bs of droppedBoosters) this.spawnBoosterDebris(bs);
      this.rebuildRocket();
    }

    // Parachute events: opening snap + rebuild for the canopy (covers both
    // manual deploys and armed chutes popped by the sim).
    const chutes = v.deployedChutes();
    if (chutes !== this.lastChutes) {
      if (chutes > this.lastChutes) AUDIO.playOneShot('chuteOpen', 0.9);
      this.lastChutes = chutes;
      this.rebuildRocket();
    }

    this.milestones();
    this.updateDebris(dt);

    if (v.destroyed && !this.endShown) {
      this.endShown = true;
      $('end-title').textContent = 'Vessel destroyed';
      $('end-msg').textContent =
        'The rocket met the ground with unreasonable enthusiasm. Revert to try that ascent again, or head back to the VAB for a redesign.';
      $('end-dialog').classList.remove('hidden');
    }

    // Engine + parachute audio follow the physics (also audible in map view)
    {
      const alt = v.pos.length() - v.body.radius;
      const atmo = v.body.atmosphere;
      const pr =
        atmo && alt < atmo.height
          ? Math.exp(-Math.max(0, alt) / atmo.scaleHeight)
          : 0;
      const thrust = v.destroyed ? 0 : v.totalThrust(pr);
      AUDIO.setEngineLevel(thrust > 0 ? 0.35 + 0.65 * Math.min(1, thrust / 215_000) : 0);
      let chuteLevel = 0;
      if (chutes > 0 && pr > 0.004 && !v.landed && !v.destroyed) {
        _spin.set(0, v.body.spinRate, 0);
        const va = _v1.crossVectors(_spin, v.pos).sub(v.vel).length();
        chuteLevel = Math.min(0.85, 0.15 + va / 120) * Math.min(1, pr * 4);
      }
      AUDIO.setChuteLevel(chuteLevel);
    }

    if (this.mode === 'flight') {
      this.syncFlight();
      this.host.renderer.render(this.scene, this.camera);
    } else {
      this.syncMap();
      this.host.renderer.render(this.mapScene, this.mapCamera);
    }
    this.navball.update(v);
    this.navball.render(this.host.renderer);
    this.updateHUD();
  }

  /** Science awards for exploration firsts (once per save). */
  private milestones(): void {
    const v = this.vessel;
    if (v.destroyed) return;
    const award = (id: string) => {
      const msg = STATE.award(id);
      if (msg) this.toast(msg);
    };
    const b = v.body;
    const lower = b.name.toLowerCase();

    if (v.dockedWith) award('dock');
    if (v.landed) {
      if (b !== HOME) award(`land-${lower}`);
      return;
    }
    const alt = v.pos.length() - b.radius;
    if (b === HOME) {
      if (alt > 10_000) award('alt10k');
      if (alt > HOME.atmosphere!.height) {
        v.reachedSpace = true;
        award('space');
      }
    } else if (b === HELIOS) {
      award('escape');
      v.reachedSpace = true;
    } else {
      award(`soi-${lower}`);
      v.reachedSpace = true;
    }
    // Stable orbit: closed and periapsis clear of atmosphere/terrain
    const clearance = b.atmosphere ? b.atmosphere.height : b.maxTerrain + 1000;
    const el = orbitalElements(v.pos, v.vel, b.mu);
    if (!el.degenerate && el.e < 1 && el.peR > b.radius + clearance && b !== HELIOS) {
      award(`orbit-${lower}`);
    }
  }

  private updateDebris(dt: number): void {
    if (this.sim.warp > 4) {
      for (const d of this.debris) this.scene.remove(d.group);
      this.debris = [];
      return;
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      const r = d.pos.length();
      if (d.age > 30 || r < d.body.radius + 1) {
        this.scene.remove(d.group);
        this.debris.splice(i, 1);
        continue;
      }
      _v1.copy(d.pos).multiplyScalar(-d.body.mu / (r * r * r));
      d.vel.addScaledVector(_v1, dt * this.sim.warp);
      d.pos.addScaledVector(d.vel, dt * this.sim.warp);
    }
  }

  // ---------------- flight-view sync ----------------

  private syncFlight(): void {
    const v = this.vessel;
    const t = this.sim.t;

    // World position of the vessel (root-centered)
    const vw = v.body.worldPosition(t, _v1).add(v.pos);

    for (const [body, mesh] of this.bodyMeshes) {
      body.worldPosition(t, _v2).sub(vw);
      mesh.position.copy(_v2);
      mesh.rotation.y = body.rotationAngle(t);
    }

    // Sunlight: place the light source on the star's side of the vessel
    _v2.copy(vw).multiplyScalar(-1).normalize(); // toward star at origin
    this.sunLight.position.copy(_v2).multiplyScalar(10_000);
    this.sunLight.target.position.set(0, 0, 0);

    // Rocket
    this.rocketHolder.quaternion.copy(v.q);
    const alt = v.pos.length() - v.body.radius;
    let pr = 0;
    if (v.body.atmosphere && alt < v.body.atmosphere.height) {
      pr = Math.exp(-Math.max(0, alt) / v.body.atmosphere.scaleHeight);
    }
    const firing = v.destroyed ? [] : v.firingEngines(pr);
    const coreThrust = firing.some((f) => !('hostIndex' in f.part));
    this.flame.visible = coreThrust;
    if (coreThrust) {
      const s = 0.75 + 0.5 * Math.random() * 0.3 + v.throttle * 0.6;
      this.flame.scale.set(1, s, 1);
    }
    // booster flames track their instance (visual order matches vessel.boosters)
    for (let i = 0; i < this.boosterFlames.length; i++) {
      const b = v.boosters[i];
      const on = !!b && b.ignited && b.fuel > 0 && !v.destroyed;
      this.boosterFlames[i].visible = on;
      if (on) {
        this.boosterFlames[i].scale.set(0.8, 0.7 + Math.random() * 0.25, 0.8);
      }
    }

    // Launch pad (fixed to the home planet's surface, on its plateau)
    const theta = HOME.rotationAngle(t);
    _v3.copy(PAD_DIR).applyAxisAngle(_v4.set(0, 1, 0), theta);
    const padWorld = HOME.worldPosition(t, _v2).addScaledVector(
      _v3,
      HOME.radius + groundHeight(HOME, PAD_DIR) + 0.3,
    );
    this.pad.position.copy(padWorld.sub(vw));
    this.pad.quaternion.setFromUnitVectors(_v4.set(0, 1, 0), _v3);
    this.pad.visible = this.pad.position.length() < 30_000;

    // Debris
    for (const d of this.debris) {
      d.body.worldPosition(t, _v2).add(d.pos).sub(vw);
      d.group.position.copy(_v2);
    }

    // Other vessels within visual range (docking partners, targets)
    for (const o of STATE.vessels) {
      if (o === v || o.destroyed || o.landed || o.body !== v.body) {
        this.dropNearby(o);
        continue;
      }
      const rel = _v2.copy(o.pos).sub(v.pos);
      if (rel.length() > 5000) {
        this.dropNearby(o);
        continue;
      }
      const sig = o.parts.length * 100 + o.deployedChutes();
      let vis = this.nearby.get(o);
      if (!vis || vis.sig !== sig) {
        this.dropNearby(o);
        const { group } = buildRocketVisual(o.parts, [
          ...o.boosters,
          ...o.radialChutes,
        ]);
        this.scene.add(group);
        vis = { group, sig };
        this.nearby.set(o, vis);
      }
      vis.group.position.copy(rel);
      vis.group.quaternion.copy(o.q);
    }
    for (const [o] of this.nearby) {
      if (!STATE.vessels.includes(o)) this.dropNearby(o);
    }

    // Sky color + stars
    const atmo = v.body.atmosphere;
    if (atmo) {
      const f = Math.exp(-Math.max(0, alt) / (atmo.scaleHeight * 1.6));
      const up = _v2.copy(v.pos).normalize();
      const sunDir = _v3.copy(vw).multiplyScalar(-1).normalize();
      const day = THREE.MathUtils.clamp(up.dot(sunDir) * 2 + 0.6, 0.04, 1);
      const sky = atmo.skyColor.clone().multiplyScalar(f * day);
      (this.scene.background as THREE.Color).copy(sky);
      (this.stars.material as THREE.PointsMaterial).opacity = THREE.MathUtils.clamp(
        1 - f * 1.6,
        0,
        0.95,
      );
    } else {
      (this.scene.background as THREE.Color).setRGB(0, 0, 0.004);
      (this.stars.material as THREE.PointsMaterial).opacity = 0.95;
    }

    // Camera: orbit around the vessel, "up" = away from the planet
    const up = _v2.copy(v.pos).normalize();
    _spin.set(0, v.body.spinRate, 0);
    const east = _v3.crossVectors(_spin, up);
    if (east.lengthSq() < 1e-12) east.set(0, 0, 1);
    east.normalize();
    const north = _v4.crossVectors(up, east).normalize();
    const cp = Math.cos(this.camPitch);
    const camDir = new THREE.Vector3()
      .addScaledVector(up, Math.sin(this.camPitch))
      .addScaledVector(east, Math.cos(this.camYaw) * cp)
      .addScaledVector(north, Math.sin(this.camYaw) * cp);
    this.camera.position.copy(camDir.multiplyScalar(this.camDist));
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
  }

  // ---------------- map-view sync ----------------

  private syncMap(): void {
    const v = this.vessel;
    const t = this.sim.t;
    const focus = v.body.worldPosition(t, _v1); // map origin

    // Camera first so labels can project correctly
    const cp = Math.cos(this.mapPitch);
    this.mapCamera.position.set(
      Math.cos(this.mapYaw) * cp * this.mapDist,
      Math.sin(this.mapPitch) * this.mapDist,
      Math.sin(this.mapYaw) * cp * this.mapDist,
    );
    this.mapCamera.up.set(0, 1, 0);
    this.mapCamera.lookAt(0, 0, 0);
    this.mapCamera.updateMatrixWorld();

    for (const [body, vis] of this.mapBodies) {
      body.worldPosition(t, _v2).sub(focus).multiplyScalar(MAP_SCALE);
      vis.mesh.position.copy(_v2);
      vis.marker.position.copy(_v2);
      const d = vis.marker.position.distanceTo(this.mapCamera.position);
      const s = d * 0.012;
      vis.marker.scale.set(s, s, 1);
      // hide the dot when the true-scale sphere is bigger on screen
      vis.marker.visible = body.radius * MAP_SCALE < d * 0.006;
      if (vis.orbit && body.parent) {
        body.parent.worldPosition(t, _v3).sub(focus).multiplyScalar(MAP_SCALE);
        vis.orbit.position.copy(_v3);
      }
      this.placeLabel(vis.label, vis.mesh.position);
    }

    // Vessel marker + orbit
    _v2.copy(v.pos).multiplyScalar(MAP_SCALE);
    this.vesselMarker.position.copy(_v2);
    const dm = _v2.distanceTo(this.mapCamera.position);
    const vs = dm * 0.01;
    this.vesselMarker.scale.set(vs, vs, 1);
    this.placeLabel(this.vesselLabel, this.vesselMarker.position);

    // Other vessels sharing this SOI
    for (const o of this.others) {
      const ov = o.vessel;
      const inWorld = STATE.vessels.includes(ov);
      if (!inWorld || ov.destroyed || ov.body !== v.body) {
        o.marker.visible = false;
        o.label.style.display = 'none';
        continue;
      }
      if (ov.landed) {
        _v3.copy(ov.landedDir)
          .applyAxisAngle(_v4.set(0, 1, 0), ov.body.rotationAngle(t))
          .multiplyScalar(ov.body.radius);
      } else {
        _v3.copy(ov.pos);
      }
      o.marker.visible = true;
      o.marker.position.copy(_v3).multiplyScalar(MAP_SCALE);
      const os = o.marker.position.distanceTo(this.mapCamera.position) * 0.008;
      o.marker.scale.set(os, os, 1);
      this.placeLabel(o.label, o.marker.position);
    }

    const path = v.landed ? null : sampleOrbit(v.pos, v.vel, v.body.mu, v.body.soi * 1.02);
    const posAttr = this.orbitGeo.getAttribute('position') as THREE.BufferAttribute;
    if (path) {
      const pts = path.points;
      const n = Math.min(pts.length, path.closed ? 599 : 600);
      for (let i = 0; i < n; i++) {
        posAttr.setXYZ(i, pts[i].x * MAP_SCALE, pts[i].y * MAP_SCALE, pts[i].z * MAP_SCALE);
      }
      let count = n;
      if (path.closed && n > 0) {
        posAttr.setXYZ(n, pts[0].x * MAP_SCALE, pts[0].y * MAP_SCALE, pts[0].z * MAP_SCALE);
        count = n + 1;
      }
      posAttr.needsUpdate = true;
      this.orbitGeo.setDrawRange(0, count);
      this.orbitLine.visible = true;
    } else {
      this.orbitLine.visible = false;
    }

    // Ap / Pe markers
    const el = v.landed ? null : orbitalElements(v.pos, v.vel, v.body.mu);
    const R = v.body.radius;
    if (el && !el.degenerate && el.peR > 0) {
      this.peMarker.visible = true;
      this.peMarker.position.copy(el.pHat).multiplyScalar(el.peR * MAP_SCALE);
      const s1 = this.peMarker.position.distanceTo(this.mapCamera.position) * 0.008;
      this.peMarker.scale.set(s1, s1, 1);
      this.apLabel.textContent = '';
      this.peLabel.textContent = `Pe ${fmtDist(el.peR - R)}`;
      this.placeLabel(this.peLabel, this.peMarker.position);
      if (el.e < 1 && isFinite(el.apR)) {
        this.apMarker.visible = true;
        this.apMarker.position.copy(el.pHat).multiplyScalar(-el.apR * MAP_SCALE);
        const s2 = this.apMarker.position.distanceTo(this.mapCamera.position) * 0.008;
        this.apMarker.scale.set(s2, s2, 1);
        this.apLabel.textContent = `Ap ${fmtDist(el.apR - R)}`;
        this.placeLabel(this.apLabel, this.apMarker.position);
      } else {
        this.apMarker.visible = false;
        this.apLabel.style.display = 'none';
      }
    } else {
      this.apMarker.visible = false;
      this.peMarker.visible = false;
      this.apLabel.style.display = 'none';
      this.peLabel.style.display = 'none';
    }

    // Info panel
    if (el && !el.degenerate) {
      $('map-info').innerHTML = `
        <div class="srow"><span>Orbiting</span><b>${v.body.name}</b></div>
        <div class="srow"><span>Eccentricity</span><b>${el.e.toFixed(3)}</b></div>
        <div class="srow"><span>Inclination</span><b>${THREE.MathUtils.radToDeg(el.inc).toFixed(1)}°</b></div>
        <div class="srow"><span>Period</span><b>${fmtTime(el.period)}</b></div>
        <div class="srow"><span>Apoapsis</span><b>${el.e < 1 ? fmtDist(el.apR - R) : '—'}</b></div>
        <div class="srow"><span>Periapsis</span><b>${fmtDist(el.peR - R)}</b></div>`;
    } else {
      $('map-info').innerHTML = `<div class="srow"><span>Orbiting</span><b>${v.body.name}</b></div>
        <div class="srow"><span>Status</span><b>${v.landed ? 'landed' : 'suborbital'}</b></div>`;
    }
  }

  private placeLabel(label: HTMLElement, worldPos: THREE.Vector3): void {
    _v4.copy(worldPos).project(this.mapCamera);
    if (_v4.z > 1 || _v4.z < -1) {
      label.style.display = 'none';
      return;
    }
    label.style.display = 'block';
    label.style.left = `${(_v4.x * 0.5 + 0.5) * window.innerWidth}px`;
    label.style.top = `${(-_v4.y * 0.5 + 0.5) * window.innerHeight}px`;
  }

  // ---------------- HUD ----------------

  private toast(text: string): void {
    showToast(text);
  }

  private updateHUD(): void {
    const v = this.vessel;
    const R = v.body.radius;
    const r = v.pos.length();
    const alt = r - R;

    $('hud-body').textContent = v.body.name;
    // Below 5 km show height above the actual terrain (AGL), else above datum
    const theta = v.body.rotationAngle(this.sim.t);
    const dirFixed = _v3.copy(v.pos).normalize().applyAxisAngle(_v4.set(0, 1, 0), -theta);
    const agl = alt - groundHeight(v.body, dirFixed) - this.rocketHeight / 2;
    $('hud-alt').textContent =
      !v.landed && agl < 5_000
        ? `${fmtDist(Math.max(0, agl))} AGL`
        : fmtDist(Math.max(0, alt - this.rocketHeight / 2));

    _spin.set(0, v.body.spinRate, 0);
    const srf = _v1.crossVectors(_spin, v.pos).sub(v.vel).length();
    const orb = v.vel.length();
    const useSrf = alt < 45_000;
    $('hud-vel-label').textContent = useSrf ? 'SRF VEL' : 'ORB VEL';
    $('hud-vel').textContent = fmtSpeed(useSrf ? srf : orb);

    if (v.landed) {
      $('hud-ap').textContent = '—';
      $('hud-pe').textContent = '—';
    } else {
      const el = orbitalElements(v.pos, v.vel, v.body.mu);
      $('hud-ap').textContent =
        !el.degenerate && el.e < 1 && isFinite(el.apR) ? fmtDist(el.apR - R) : '—';
      $('hud-pe').textContent = !el.degenerate ? fmtDist(el.peR - R) : '—';
    }

    $('hud-met').textContent =
      v.launchedAt !== null ? `T+ ${fmtTime(this.sim.t - v.launchedAt)}` : 'PRE-LAUNCH';
    $('hud-warp').textContent = `${this.sim.warp}×`;

    $('throttle-pct').textContent = `${Math.round(v.throttle * 100)}%`;
    $('throttle-fill').style.width = `${v.throttle * 100}%`;
    const ff = v.stageFuelFraction();
    $('fuel-pct').textContent = `${Math.round(ff * 100)}%`;
    $('fuel-fill').style.width = `${ff * 100}%`;

    $('sas-ind').classList.toggle('on', v.sas);
    $('ap-ind').classList.toggle('on', this.sim.autopilot.active);
    $('stage-ind').textContent = `STAGE ${v.stageCount()}`;
    $('next-ind').textContent = `␣ ${v.nextStageLabel()}`;
    $('dock-ind').classList.toggle('hidden', !v.dockedWith);
    this.refreshApTargets();
    const up = _v1.set(0, 1, 0).applyQuaternion(v.q);
    const radial = _v2.copy(v.pos).normalize();
    const tilt = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(up.dot(radial), -1, 1)));
    $('tilt-ind').textContent = `TILT ${tilt.toFixed(0)}°`;
  }
}
