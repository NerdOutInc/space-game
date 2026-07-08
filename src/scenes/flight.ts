import * as THREE from 'three';
import { AUDIO } from '../audio';
import { GameHost, GameScene } from '../host';
import { orbitalElements, sampleOrbit } from '../math/kepler';
import {
  addAtmosphereShell,
  makeAtmosphereMaterial,
  updateAtmosphereSun,
} from '../render/atmosphere';
import { buildCampus } from '../render/campus';
import { Navball } from '../render/navball';
import { EnginePlume, ReentryParticles } from '../render/particles';
import { buildFlame, buildRocketVisual } from '../render/rocketMesh';
import { makeBodyTexture, makeDotTexture, makeStarfield } from '../render/textures';
import { Controls, Simulation } from '../sim/simulation';
import { STATE } from '../state';
import { BODIES, Body, HELIOS, HOME } from '../universe/bodies';
import { displacePlanetGeometry, groundHeight, PAD_DIR } from '../universe/terrain';
import { $, fmtDist, fmtSpeed, fmtTime } from '../util/format';
import { showToast } from '../util/toast';
import { BoosterInstance, Vessel } from '../vessel/vessel';

const MAP_SCALE = 1e-6; // meters → map units

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _f1 = new THREE.Vector3();
const _f2 = new THREE.Vector3();
const _campusMat = new THREE.Matrix4();

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
  /** Atmosphere shell materials that need per-frame sun direction updates. */
  private atmoMats: Array<{ body: Body; mat: THREE.ShaderMaterial }> = [];
  private mapAtmoMats: Array<{ body: Body; mat: THREE.ShaderMaterial }> = [];
  private stars: THREE.Points;
  private sunLight: THREE.DirectionalLight;
  private rocketHolder = new THREE.Group();
  private flame: THREE.Mesh;
  private boosterFlames: THREE.Mesh[] = [];
  private particles = new ReentryParticles();
  private plume = new EnginePlume();
  private partGroups: THREE.Group[] = [];
  private pendingBurst = false;
  private rocketHeight = 0;
  private lastOwnSig = -1;
  private campus: THREE.Group;
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
  /** Every label this scene owns — re-attached on enter() because the
   * previous scene's exit() clears the shared container. */
  private allLabels: HTMLElement[] = [];
  private orbitLine: THREE.Line;
  private orbitGeo: THREE.BufferGeometry;
  private selOrbitLine!: THREE.Line;
  private selOrbitGeo!: THREE.BufferGeometry;
  private apMarker: THREE.Sprite;
  private peMarker: THREE.Sprite;
  private apLabel: HTMLElement;
  private peLabel: HTMLElement;

  private mode: 'flight' | 'map' = 'flight';
  /** What the map camera centers on: null = follow this vessel's body. */
  private mapFocus: Body | Vessel | null = null;
  private labelSlots: Array<{ x: number; y: number }> = [];
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
        const atmoMat = addAtmosphereShell(mesh, body);
        if (atmoMat) this.atmoMats.push({ body, mat: atmoMat });
      }
      this.bodyMeshes.set(body, mesh);
      this.scene.add(mesh);
    }

    this.flame = buildFlame();
    this.scene.add(this.particles.points);
    this.plume.addTo(this.scene);
    this.scene.add(this.rocketHolder);
    this.rebuildRocket();

    // The whole space center campus sits at the launch site (floodlit!),
    // with a ground apron so nothing hovers over the coarse planet mesh
    this.campus = buildCampus(true);
    this.scene.add(this.campus);

    // ---------- map scene ----------
    const dot = makeDotTexture();
    const labels = $('map-labels');
    labels.innerHTML = '';

    for (const body of BODIES) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(body.radius * MAP_SCALE, 0.02), 48, 24),
        body.isStar
          ? new THREE.MeshBasicMaterial({ color: body.color })
          : new THREE.MeshBasicMaterial({ map: makeBodyTexture(body) }),
      );
      if (body.atmosphere) {
        // Soft haze fading from the surface outward (same shader as flight view)
        const planetR = body.radius * MAP_SCALE;
        const shellR = (body.radius + body.atmosphere.height * 4) * MAP_SCALE;
        const hazeMat = makeAtmosphereMaterial(
          body.atmosphere.skyColor.clone(),
          planetR,
          shellR,
          body.atmosphere.height * 1.3 * MAP_SCALE,
          0.85,
        );
        const haze = new THREE.Mesh(new THREE.SphereGeometry(shellR, 48, 24), hazeMat);
        mesh.add(haze);
        this.mapAtmoMats.push({ body, mat: hazeMat });
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
      label.addEventListener('click', () => (this.mapFocus = body));
      labels.appendChild(label);
      this.allLabels.push(label);
      this.mapBodies.set(body, { mesh, marker, orbit, label });
    }

    this.vesselMarker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: dot, color: 0x7dffa8, depthTest: false }),
    );
    this.mapScene.add(this.vesselMarker);
    this.vesselLabel = document.createElement('div');
    this.vesselLabel.className = 'map-label marker-label';
    this.vesselLabel.textContent = `● ${vessel.name}`;
    this.vesselLabel.addEventListener('click', () => (this.mapFocus = null));
    labels.appendChild(this.vesselLabel);
    this.allLabels.push(this.vesselLabel);

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
      label.addEventListener('click', () => (this.mapFocus = other));
      labels.appendChild(label);
      this.allLabels.push(label);
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

    // second conic for whatever vessel is focused in the map
    this.selOrbitGeo = new THREE.BufferGeometry();
    this.selOrbitGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(600 * 3), 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    this.selOrbitLine = new THREE.Line(
      this.selOrbitGeo,
      new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9 }),
    );
    this.selOrbitLine.frustumCulled = false;
    this.selOrbitLine.visible = false;
    this.mapScene.add(this.selOrbitLine);

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
    this.allLabels.push(this.apLabel, this.peLabel);

    this.onResize();
  }

  // ---------------- lifecycle ----------------

  enter(): void {
    $('flight-ui').classList.remove('hidden');
    $('end-dialog').classList.add('hidden');
    // re-attach our labels (a previous scene's exit clears the container)
    const labelBox = $('map-labels');
    for (const l of this.allLabels) labelBox.appendChild(l);
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
    this.particles.dispose();
    this.plume.dispose();
    this.navball.dispose();
    // This scene is per-flight: free GPU resources when leaving it.
    // (Textures are NOT disposed — planet/dot textures are cached and
    // shared across scenes.)
    for (const scene of [this.scene, this.mapScene]) {
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m?.dispose();
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
      case 'KeyH':
        if (this.mode === 'map') {
          this.mapFocus = null;
          this.toast('Map focus: your ship');
        }
        break;
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
    $('pause-sc').onclick = () => this.host.toSpaceCenter();
    $('pause-tovab').onclick = () => this.host.toVAB();
    $('pause-terminate').onclick = () => this.host.removeVessel(this.vessel);
    $('pause-recover').onclick = () => this.host.recoverVessel(this.vessel);
    // Flight pause shows the full set (VAB pause hides these)
    $('pause-sc').textContent = 'Space Center (flight continues)';
    for (const id of ['pause-revert', 'pause-sc', 'pause-tovab', 'pause-terminate']) {
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
    // use the CURRENT (post-separation) stack height so the debris appears
    // exactly where those parts were a frame ago
    const pos = this.vessel.pos
      .clone()
      .addScaledVector(up, -(this.vessel.stackHeight() / 2 + droppedH / 2 + 0.1));
    const vel = this.vessel.vel.clone().addScaledVector(up, -2.5);
    group.quaternion.copy(this.vessel.q);
    this.debris.push({ group, body: this.vessel.body, pos, vel, age: 0 });
  }

  /**
   * Emissive tint on part meshes: strongest on the part meeting the airflow,
   * halving per part up the stack — so you can SEE what's taking the heat.
   */
  private applyHeatGlow(vAirHat: THREE.Vector3 | null, leadTop: boolean): void {
    const v = this.vessel;
    const g0 = THREE.MathUtils.clamp((v.skinTemp - 430) / 800, 0, 1);
    const side = vAirHat === null;
    const n = this.partGroups.length;
    for (let i = 0; i < n; i++) {
      const dist = side ? 1.5 : leadTop ? i : n - 1 - i;
      const f = g0 * Math.pow(0.5, dist);
      this.partGroups[i]?.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && m.emissive) m.emissive.setRGB(f, f * 0.22, f * 0.05);
      });
    }
  }

  private dropNearby(o: Vessel): void {
    const vis = this.nearby.get(o);
    if (!vis) return;
    this.scene.remove(vis.group);
    this.nearby.delete(o);
  }

  private rebuildRocket(): void {
    this.rocketHolder.clear();
    const { group, height, boosterMounts, partGroups } = buildRocketVisual(
      this.vessel.parts,
      [...this.vessel.boosters, ...this.vessel.radialChutes],
    );
    this.rocketHeight = height;
    this.partGroups = partGroups;
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
        this.syncFlight(0);
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
      for (const m of this.sim.step(chunk, ctrl)) {
        this.toast(m);
        if (m.includes('burned up') || m.includes('overheated')) this.pendingBurst = true;
      }
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

    // Rebuild the visual when the craft changes shape: staging is handled
    // above, but chute deploys/tears and reentry burn-offs happen in the sim.
    const chutes = v.deployedChutes();
    const ownSig =
      v.parts.length * 10_000 + v.boosters.length * 100 + chutes * 10 + v.allChutes().length;
    if (ownSig !== this.lastOwnSig) {
      const prevChutes = Math.floor((this.lastOwnSig % 100) / 10);
      if (this.lastOwnSig >= 0 && chutes > prevChutes) AUDIO.playOneShot('chuteOpen', 0.9);
      this.lastOwnSig = ownSig;
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
      this.syncFlight(dt);
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

  private syncFlight(dt: number): void {
    const v = this.vessel;
    const t = this.sim.t;

    // World position of the vessel (root-centered)
    const vw = v.body.worldPosition(t, _v1).add(v.pos);

    for (const [body, mesh] of this.bodyMeshes) {
      body.worldPosition(t, _v2).sub(vw);
      mesh.position.copy(_v2);
      mesh.rotation.y = body.rotationAngle(t);
    }

    // Sunlight: place the light source on the star's side of the vessel,
    // and eclipse it when a body sits between the vessel and Helios (soft
    // ambient stays on so the night side remains playable).
    const sunDist = vw.length();
    _v2.copy(vw).multiplyScalar(-1 / sunDist); // unit vector toward the star
    let lit = 1;
    for (const body of BODIES) {
      if (body.isStar) continue;
      body.worldPosition(t, _v3).sub(vw); // vessel → body center
      const along = _v3.dot(_v2);
      if (along <= 0 || along >= sunDist) continue; // body not between us and the sun
      const missSq = Math.max(0, _v3.lengthSq() - along * along);
      const miss = Math.sqrt(missSq);
      // soft penumbra edge over ~4% of the body radius
      lit = Math.min(
        lit,
        THREE.MathUtils.clamp((miss - body.radius) / (body.radius * 0.04), 0, 1),
      );
    }
    this.sunLight.intensity = 2.2 * lit;
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
    // In atmosphere the particles ARE the plume, so the cone shrinks to a
    // bright core; in vacuum (no particles) the cone grows back to a full
    // classic exhaust spike.
    const airVis = Math.min(1, (pr > 0 ? v.body.atmosphere!.rho0 * pr : 0) / 0.02);
    const coneLen = 1 - 0.55 * airVis;
    this.flame.visible = coreThrust;
    if (coreThrust) {
      const s = 0.75 + 0.5 * Math.random() * 0.3 + v.throttle * 0.6;
      this.flame.scale.set(0.8, s * coneLen, 0.8);
    }
    // booster flames track their instance (visual order matches vessel.boosters)
    for (let i = 0; i < this.boosterFlames.length; i++) {
      const b = v.boosters[i];
      const on = !!b && b.ignited && b.fuel > 0 && !v.destroyed;
      this.boosterFlames[i].visible = on;
      if (on) {
        this.boosterFlames[i].scale.set(0.7, (0.35 + Math.random() * 0.12) * (coneLen + 0.4), 0.7);
      }
    }

    // Exhaust + smoke particles from every firing nozzle
    if (dt > 0 && !v.destroyed) {
      const atmoP = v.body.atmosphere;
      let rho = 0;
      if (atmoP && alt < atmoP.height) {
        rho = atmoP.rho0 * Math.exp(-Math.max(0, alt) / atmoP.scaleHeight);
      }
      // drift keeps the plume anchored to the air (capped so orbital burns
      // still show a readable jet instead of vanishing instantly)
      _spin.set(0, v.body.spinRate, 0);
      _f1.copy(v.vel).sub(_f2.crossVectors(_spin, v.pos));
      if (_f1.length() > 120) _f1.setLength(120);
      _f1.multiplyScalar(dt);
      if (coreThrust) {
        const coreLevel = Math.min(
          1,
          firing
            .filter((f) => !('hostIndex' in f.part))
            .reduce((s, f) => s + f.thrust, 0) / 215_000,
        );
        _f2.set(0, -this.rocketHeight / 2, 0).applyQuaternion(v.q);
        this.plume.emit(dt, _f2, v.q, Math.max(0.25, coreLevel), rho);
      }
      for (let i = 0; i < this.boosterFlames.length; i++) {
        const b = v.boosters[i];
        if (b && b.ignited && b.fuel > 0) {
          _f2.copy(this.boosterFlames[i].position).applyQuaternion(v.q);
          this.plume.emit(dt, _f2, v.q, 0.9, rho);
        }
      }
      this.plume.update(dt, _f1);
    } else {
      this.plume.update(dt, null);
    }

    // Space center campus (fixed to the home planet's surface plateau)
    const theta = HOME.rotationAngle(t);
    _v3.copy(PAD_DIR).applyAxisAngle(_v4.set(0, 1, 0), theta); // local up
    const padWorld = HOME.worldPosition(t, _v2).addScaledVector(
      _v3,
      HOME.radius + groundHeight(HOME, PAD_DIR) - 1.8,
    );
    this.campus.position.copy(padWorld.sub(vw));
    this.campus.visible = this.campus.position.length() < 60_000;
    if (this.campus.visible) {
      _f1.crossVectors(_v4.set(0, 1, 0), _v3).normalize(); // east
      _f2.crossVectors(_v3, _f1); // north
      // NB: (north, up, east) is the right-handed column order — the
      // (east, up, north) variant is a reflection and breaks the rotation
      _campusMat.makeBasis(_f2, _v3, _f1);
      this.campus.quaternion.setFromRotationMatrix(_campusMat);
    }

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

    // Reentry effects: skin particles and part heat glow
    {
      const atmo2 = v.body.atmosphere;
      let heat = 0;
      let vAirHat: THREE.Vector3 | null = null;
      if (atmo2 && alt < atmo2.height && !v.landed && !v.destroyed) {
        const rho = atmo2.rho0 * Math.exp(-Math.max(0, alt) / atmo2.scaleHeight);
        _spin.set(0, v.body.spinRate, 0);
        const vAir = _v3.copy(v.vel).sub(_v4.crossVectors(_spin, v.pos));
        const va = vAir.length();
        heat = 2e-6 * rho * va * va * va;
        if (heat > 10 && va > 30) {
          vAirHat = vAir.divideScalar(va); // = _v3
        }
      }

      // Particles hug the hull and stream downstream (-vAir); a shower marks
      // a part burning away. Embers need genuinely HOT skin — a max-Q climb
      // warms the hull but doesn't ablate it, so ascents stay clean.
      const leadTop = vAirHat
        ? _v4.set(0, 1, 0).applyQuaternion(v.q).dot(vAirHat) > 0
        : false;
      const downstream = vAirHat ? _v2.copy(vAirHat).negate() : null;
      const ember = THREE.MathUtils.clamp((v.skinTemp - 550) / 250, 0, 1);
      const rate = Math.min(700, Math.max(0, (heat - 25) * 9)) * ember;
      if (this.pendingBurst && downstream) {
        this.particles.burst(90, v.q, this.rocketHeight, leadTop, downstream);
        this.pendingBurst = false;
      }
      this.particles.update(
        dt,
        vAirHat ? rate : 0,
        v.q,
        this.rocketHeight,
        leadTop,
        downstream,
      );

      // Leading parts blush red as the skin heats
      this.applyHeatGlow(vAirHat, leadTop);
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

    // Atmospheres scatter sunlight — keep their sun direction current so
    // the night side goes dark (no more planets glowing from across space)
    this.camera.updateMatrixWorld();
    for (const { body, mat } of this.atmoMats) {
      body.worldPosition(t, _v3).multiplyScalar(-1).normalize(); // toward Helios
      updateAtmosphereSun(mat, _v3, this.camera);
    }
  }

  // ---------------- map-view sync ----------------

  /** Where the map camera is centered (click labels to change, H = home). */
  private resolveMapFocus(t: number, out: THREE.Vector3): void {
    let f = this.mapFocus;
    if (f instanceof Vessel && (f.destroyed || !STATE.vessels.includes(f))) {
      this.mapFocus = null;
      f = null;
    }
    if (f === null) {
      this.vessel.body.worldPosition(t, out);
    } else if (f instanceof Vessel) {
      f.body.worldPosition(t, out);
      if (f.landed) {
        _f2.copy(f.landedDir)
          .applyAxisAngle(_f1.set(0, 1, 0), f.body.rotationAngle(t))
          .multiplyScalar(f.body.radius);
        out.add(_f2);
      } else {
        out.add(f.pos);
      }
    } else {
      f.worldPosition(t, out);
    }
  }

  private syncMap(): void {
    const v = this.vessel;
    const t = this.sim.t;
    this.labelSlots.length = 0;
    const focus = _v1; // map origin
    this.resolveMapFocus(t, focus);

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
      // textured globes spin with the real planet, so what you see is
      // where you'd actually land
      vis.mesh.rotation.y = body.rotationAngle(t);
      vis.marker.position.copy(_v2);
      const d = vis.marker.position.distanceTo(this.mapCamera.position);
      const s = d * 0.012;
      vis.marker.scale.set(s, s, 1);
      // hide the dot when the true-scale sphere is bigger on screen
      vis.marker.visible = body.radius * MAP_SCALE < d * 0.006;
      if (vis.orbit && body.parent) {
        body.parent.worldPosition(t, _v3).sub(focus).multiplyScalar(MAP_SCALE);
        vis.orbit.position.copy(_v3);
        // the focused body's own orbit lights up
        (vis.orbit.material as THREE.LineBasicMaterial).opacity =
          this.mapFocus === body ? 0.95 : 0.45;
      }
      this.placeLabel(vis.label, vis.mesh.position);
    }

    // Map atmospheres get the same sunlight treatment
    for (const { body, mat } of this.mapAtmoMats) {
      body.worldPosition(t, _v2).multiplyScalar(-1).normalize();
      updateAtmosphereSun(mat, _v2, this.mapCamera);
    }

    // Vessel marker + orbit (positions are relative to the focus point)
    const vOff = v.body.worldPosition(t, _f1).sub(focus); // stays in _f1
    _v2.copy(vOff).add(v.pos).multiplyScalar(MAP_SCALE);
    this.vesselMarker.position.copy(_v2);
    const dm = _v2.distanceTo(this.mapCamera.position);
    const vs = dm * 0.01;
    this.vesselMarker.scale.set(vs, vs, 1);
    this.placeLabel(this.vesselLabel, this.vesselMarker.position);

    // Every other vessel in the system, wherever it is
    for (const o of this.others) {
      const ov = o.vessel;
      const inWorld = STATE.vessels.includes(ov);
      if (!inWorld || ov.destroyed) {
        o.marker.visible = false;
        o.label.style.display = 'none';
        continue;
      }
      ov.body.worldPosition(t, _v3).sub(focus);
      if (ov.landed) {
        _v4.copy(ov.landedDir)
          .applyAxisAngle(_v2.set(0, 1, 0), ov.body.rotationAngle(t))
          .multiplyScalar(ov.body.radius);
        _v3.add(_v4);
      } else {
        _v3.add(ov.pos);
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
    // orbit geometry is body-centered — shift it by the focus offset
    this.orbitLine.position.set(
      vOff.x * MAP_SCALE,
      vOff.y * MAP_SCALE,
      vOff.z * MAP_SCALE,
    );

    // ---- selection: whose conic and Ap/Pe do we highlight?
    const fSel = this.mapFocus;
    const selVessel = fSel instanceof Vessel ? fSel : null;
    // null focus = your own ship; a body focus shows no Ap/Pe at all
    const target = fSel === null ? v : selVessel;

    // Focused vessel gets its own drawn conic (cyan) around ITS body
    if (selVessel && !selVessel.landed && !selVessel.destroyed) {
      const sOff = selVessel.body.worldPosition(t, _f2).sub(focus); // stays in _f2
      const sPath = sampleOrbit(
        selVessel.pos,
        selVessel.vel,
        selVessel.body.mu,
        selVessel.body.soi * 1.02,
      );
      const sAttr = this.selOrbitGeo.getAttribute('position') as THREE.BufferAttribute;
      if (sPath) {
        const pts = sPath.points;
        const n = Math.min(pts.length, sPath.closed ? 599 : 600);
        for (let i = 0; i < n; i++) {
          sAttr.setXYZ(i, pts[i].x * MAP_SCALE, pts[i].y * MAP_SCALE, pts[i].z * MAP_SCALE);
        }
        let count = n;
        if (sPath.closed && n > 0) {
          sAttr.setXYZ(n, pts[0].x * MAP_SCALE, pts[0].y * MAP_SCALE, pts[0].z * MAP_SCALE);
          count = n + 1;
        }
        sAttr.needsUpdate = true;
        this.selOrbitGeo.setDrawRange(0, count);
        this.selOrbitLine.position.set(
          sOff.x * MAP_SCALE,
          sOff.y * MAP_SCALE,
          sOff.z * MAP_SCALE,
        );
        this.selOrbitLine.visible = true;
      } else {
        this.selOrbitLine.visible = false;
      }
    } else {
      this.selOrbitLine.visible = false;
    }

    // Ap / Pe markers — only for the selected item
    const el =
      target && !target.landed
        ? orbitalElements(target.pos, target.vel, target.body.mu)
        : null;
    const R = target ? target.body.radius : v.body.radius;
    const anchor = target === v ? vOff : _f2; // _f2 holds the sel body offset
    if (el && !el.degenerate && el.peR > 0 && target) {
      this.peMarker.visible = true;
      this.peMarker.position
        .copy(el.pHat)
        .multiplyScalar(el.peR * MAP_SCALE)
        .addScaledVector(anchor, MAP_SCALE);
      const s1 = this.peMarker.position.distanceTo(this.mapCamera.position) * 0.008;
      this.peMarker.scale.set(s1, s1, 1);
      this.apLabel.textContent = '';
      this.peLabel.textContent = `Pe ${fmtDist(el.peR - R)}`;
      this.placeLabel(this.peLabel, this.peMarker.position);
      if (el.e < 1 && isFinite(el.apR)) {
        this.apMarker.visible = true;
        this.apMarker.position
          .copy(el.pHat)
          .multiplyScalar(-el.apR * MAP_SCALE)
          .addScaledVector(anchor, MAP_SCALE);
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
    const f = this.mapFocus;
    const focusName =
      f === null ? `${v.name} (you)` : f instanceof Vessel ? f.name : f.name;
    const focusRow = `<div class="srow"><span>Focus</span><b>${focusName}</b></div>`;
    const takeBtn =
      f instanceof Vessel && f !== v && !f.destroyed
        ? `<button class="btn take-btn" id="btn-take">🎮 TAKE CONTROL</button>`
        : '';
    const hint = `<div class="map-hint">click labels to focus · H = your ship</div>`;
    if (el && !el.degenerate) {
      $('map-info').innerHTML = `${focusRow}
        <div class="srow"><span>Orbiting</span><b>${(target ?? v).body.name}</b></div>
        <div class="srow"><span>Eccentricity</span><b>${el.e.toFixed(3)}</b></div>
        <div class="srow"><span>Inclination</span><b>${THREE.MathUtils.radToDeg(el.inc).toFixed(1)}°</b></div>
        <div class="srow"><span>Period</span><b>${fmtTime(el.period)}</b></div>
        <div class="srow"><span>Apoapsis</span><b>${el.e < 1 ? fmtDist(el.apR - R) : '—'}</b></div>
        <div class="srow"><span>Periapsis</span><b>${fmtDist(el.peR - R)}</b></div>${takeBtn}${hint}`;
    } else {
      $('map-info').innerHTML = `${focusRow}
        <div class="srow"><span>Orbiting</span><b>${v.body.name}</b></div>
        <div class="srow"><span>Status</span><b>${v.landed ? 'landed' : 'suborbital'}</b></div>${takeBtn}${hint}`;
    }
    if (takeBtn) {
      const target = f as Vessel;
      $('btn-take').onclick = () => this.host.flyVessel(target);
    }
  }

  private placeLabel(label: HTMLElement, worldPos: THREE.Vector3): void {
    _v4.copy(worldPos).project(this.mapCamera);
    if (_v4.z > 1 || _v4.z < -1) {
      label.style.display = 'none';
      return;
    }
    label.style.display = 'block';
    const x = (_v4.x * 0.5 + 0.5) * window.innerWidth;
    let y = (-_v4.y * 0.5 + 0.5) * window.innerHeight;
    // declutter: stack labels downward instead of overlapping
    for (let guard = 0; guard < 8; guard++) {
      const hit = this.labelSlots.some(
        (s) => Math.abs(s.x - x) < 90 && Math.abs(s.y - y) < 13,
      );
      if (!hit) break;
      y += 13;
    }
    this.labelSlots.push({ x, y });
    label.style.left = `${x}px`;
    label.style.top = `${y}px`;
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
    const temp = $('hud-temp');
    temp.textContent = `${Math.round(v.skinTemp)} K`;
    temp.className = v.skinTemp > 950 ? 'hot' : v.skinTemp > 600 ? 'warm' : '';

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
