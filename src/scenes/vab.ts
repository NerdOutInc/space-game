import * as THREE from 'three';
import { AUDIO } from '../audio';
import { GameHost, GameScene } from '../host';
import { buildPartMesh, buildRocketVisual } from '../render/rocketMesh';
import { STATE } from '../state';
import { $, fmtDist, fmtMass, fmtTime } from '../util/format';
import { showToast } from '../util/toast';
import {
  CraftDesign,
  CraftSlot,
  RadialGroup,
  actionLabel,
  defaultStages,
  emptyCraft,
  makeSlot,
  nextUid,
  reconcileStages,
} from '../vessel/craft';
import {
  PART_BY_ID,
  PARTS,
  PartDef,
  SAMPLE_ROCKET,
  SAMPLE_STARTER,
  SampleSlot,
  canHostRadials,
} from '../vessel/parts';
import { computeStageStats, designTotals } from '../vessel/vessel';

const CATEGORIES: Array<{ label: string; types: string[] }> = [
  { label: 'Command & Recovery', types: ['capsule', 'parachute', 'dock', 'shield'] },
  { label: 'Engines & Tanks', types: ['tank', 'engine', 'srb'] },
  { label: 'Aero & Structural', types: ['nose', 'adapter', 'fin', 'decoupler'] },
  { label: 'Landing & Maneuvering', types: ['legs', 'rcs'] },
];

/** What the cursor is carrying: a fresh part or a picked-up piece. */
interface Holding {
  def: PartDef;
  mode: 'stack' | 'radial';
  symmetry: number; // radial copies when placed
  /** Re-placing an existing stack slot (keeps uid → keeps stage edits). */
  slotPayload?: CraftSlot;
  /** Re-placing an existing radial group. */
  groupPayload?: RadialGroup;
}

interface SnapPick {
  kind: 'joint' | 'surface';
  jointIndex: number; // stack insertion index
  hostIndex: number; // radial host slot index
  angle: number; // azimuth on the host
}

function sampleToDesign(sample: SampleSlot[]): CraftDesign {
  const slots: CraftSlot[] = sample.map((s) => {
    const slot = makeSlot(PART_BY_ID[s.id]);
    for (const r of s.radials ?? []) {
      slot.radials.push({ uid: nextUid(), def: PART_BY_ID[r.id], count: r.count });
    }
    return slot;
  });
  return { slots, stages: defaultStages(slots) };
}

function sampleParts(sample: SampleSlot[]): PartDef[] {
  const defs: PartDef[] = [];
  for (const s of sample) {
    defs.push(PART_BY_ID[s.id]);
    for (const r of s.radials ?? []) defs.push(PART_BY_ID[r.id]);
  }
  return defs;
}

const _ndc = new THREE.Vector2();
const _pt = new THREE.Vector3();

export class VABScene implements GameScene {
  private host: GameHost;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  private rocketHolder = new THREE.Group();
  private markerHolder = new THREE.Group();
  private ghostHolder = new THREE.Group();
  private craft: CraftDesign = emptyCraft();
  private holding: Holding | null = null;
  private bound = false;
  private paused = false;
  private missionTimer = 0;

  // rebuilt on every refresh()
  private partMeshes: Array<{ mesh: THREE.Object3D; slotIndex: number }> = [];
  private radialMeshes: Array<{ mesh: THREE.Object3D; groupUid: number }> = [];
  private jointYs: number[] = []; // world y of each stack insertion point
  private craftHeight = 0;
  private raycaster = new THREE.Raycaster();
  private pointer = { x: 0, y: 0, has: false };
  private snap: SnapPick | null = null;

  // camera controls
  private yaw = 0;
  private zoom = 1;
  private dragging = false;
  private lastX = 0;
  private autoSpin = true;

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) return; // right-click handled via contextmenu
    if (this.holding) {
      if (this.snap) this.placeHolding();
      return; // no snap: keep carrying (click-through spins nothing)
    }
    // try to pick up a part under the cursor
    if (this.pickUpAt()) return;
    this.dragging = true;
    this.autoSpin = false;
    this.lastX = e.clientX;
  };
  private onPointerMove = (e: PointerEvent) => {
    this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this.pointer.has = true;
    if (!this.dragging) return;
    this.yaw += (e.clientX - this.lastX) * 0.008;
    this.lastX = e.clientX;
  };
  private onPointerUp = () => (this.dragging = false);
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom = THREE.MathUtils.clamp(this.zoom * Math.pow(1.1, e.deltaY * 0.01), 0.4, 2.6);
  };
  private onContextMenu = (e: MouseEvent) => {
    if (this.holding) {
      e.preventDefault();
      this.discardHolding();
    }
  };

  constructor(host: GameHost) {
    this.host = host;

    this.scene.background = new THREE.Color(0x10141b);
    this.scene.fog = new THREE.Fog(0x10141b, 30, 90);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(60, 48),
      new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(60, 30, 0x2e3947, 0x232b36);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.LineBasicMaterial).opacity = 0.6;
    grid.position.y = 0.01;
    this.scene.add(grid);

    this.scene.add(new THREE.AmbientLight(0xaebfd4, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, 12, 8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fd4ff, 0.7);
    rim.position.set(-8, 6, -6);
    this.scene.add(rim);

    this.scene.add(this.rocketHolder);
    this.scene.add(this.markerHolder);
    this.scene.add(this.ghostHolder);
    this.onResize();
    if (import.meta.env.DEV) {
      (window as unknown as { __vab?: VABScene }).__vab = this;
    }
  }

  enter(): void {
    $('vab-ui').classList.remove('hidden');
    AUDIO.playMusic('dunes');
    if (!this.bound) {
      this.bind();
      this.bound = true;
    }
    const canvas = this.host.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
    this.paused = false;
    this.refresh();
    this.refreshMissions();
  }

  exit(): void {
    this.discardHolding();
    $('vab-ui').classList.add('hidden');
    $('pause-menu').classList.add('hidden');
    const canvas = this.host.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
  }

  onKeyDown(e: KeyboardEvent): void {
    if (this.paused) {
      if (e.code === 'Escape') this.setPaused(false);
      return;
    }
    if (this.holding) {
      switch (e.code) {
        case 'Escape':
        case 'Delete':
        case 'Backspace':
          this.discardHolding();
          return;
        case 'KeyR':
          this.toggleHoldMode();
          return;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4':
          this.setSymmetry(Number(e.code.slice(-1)));
          return;
      }
      return;
    }
    if (e.code === 'Escape') this.setPaused(!this.paused);
  }

  onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- holding / placement ----------------

  private grab(holding: Holding): void {
    this.discardHolding();
    this.holding = holding;
    this.autoSpin = false;
    this.refreshHoldHud();
  }

  private toggleHoldMode(): void {
    const h = this.holding;
    if (!h || h.def.mount !== 'both') return;
    h.mode = h.mode === 'stack' ? 'radial' : 'stack';
    this.refreshHoldHud();
  }

  private setSymmetry(n: number): void {
    const h = this.holding;
    if (!h || h.mode !== 'radial') return;
    h.symmetry = THREE.MathUtils.clamp(n, 1, 4);
    if (h.groupPayload) h.groupPayload.count = h.symmetry;
    this.refreshHoldHud();
  }

  /** Drop whatever the cursor carries (parts return to the bin, not the ship). */
  private discardHolding(): void {
    if (!this.holding) return;
    this.holding = null;
    this.snap = null;
    this.ghostHolder.clear();
    this.refreshHoldHud();
    // stage chips of a discarded piece vanish with it
    reconcileStages(this.craft);
    this.refreshStats();
    this.refreshStages();
  }

  /** Pick up the craft piece under the cursor. Returns true when grabbed. */
  private pickUpAt(): boolean {
    this.updateRay();
    const targets = [
      ...this.partMeshes.map((p) => p.mesh),
      ...this.radialMeshes.map((r) => r.mesh),
    ];
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return false;
    let obj: THREE.Object3D | null = hits[0].object;
    while (obj) {
      const radial = this.radialMeshes.find((r) => r.mesh === obj);
      if (radial) {
        for (const slot of this.craft.slots) {
          const gi = slot.radials.findIndex((g) => g.uid === radial.groupUid);
          if (gi >= 0) {
            const group = slot.radials.splice(gi, 1)[0];
            this.grab({
              def: group.def,
              mode: 'radial',
              symmetry: group.count,
              groupPayload: group,
            });
            // NO reconcile here: the carried piece keeps its stage chips,
            // so re-placing it preserves the user's stage arrangement.
            this.refresh();
            return true;
          }
        }
      }
      const part = this.partMeshes.find((p) => p.mesh === obj);
      if (part) {
        const slot = this.craft.slots.splice(part.slotIndex, 1)[0];
        this.grab({
          def: slot.def,
          mode: 'stack',
          symmetry: 2,
          slotPayload: slot, // carries its radials and stage placements along
        });
        this.refresh();
        return true;
      }
      obj = obj.parent;
    }
    return false;
  }

  private placeHolding(): void {
    const h = this.holding;
    const s = this.snap;
    if (!h || !s) return;
    if (s.kind === 'joint') {
      const slot = h.slotPayload ?? makeSlot(h.def);
      this.craft.slots.splice(s.jointIndex, 0, slot);
    } else {
      const host = this.craft.slots[s.hostIndex];
      if (!host) return;
      const group: RadialGroup =
        h.groupPayload ?? { uid: nextUid(), def: h.def, count: h.symmetry };
      group.count = h.symmetry;
      host.radials.push(group);
    }
    this.holding = null;
    this.snap = null;
    this.ghostHolder.clear();
    this.refreshHoldHud();
    this.afterStructureChange();
  }

  private afterStructureChange(): void {
    reconcileStages(this.craft);
    this.refresh();
  }

  // ---------------- snapping ----------------

  private updateRay(): void {
    _ndc.set(this.pointer.x, this.pointer.y);
    this.raycaster.setFromCamera(_ndc, this.camera);
  }

  /** Recompute the snap target + ghost preview for the current pointer. */
  private updateSnap(): void {
    this.ghostHolder.clear();
    this.snap = null;
    const h = this.holding;
    if (!h || !this.pointer.has) return;
    this.updateRay();

    if (h.mode === 'stack') {
      // nearest stack joint to the pointer ray
      let best = -1;
      let bestD = 1.6 * Math.max(1, this.zoom); // grab radius scales with zoom
      this.jointYs.forEach((y, j) => {
        const d = this.raycaster.ray.distanceToPoint(_pt.set(0, y, 0));
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      if (best < 0) return;
      this.snap = { kind: 'joint', jointIndex: best, hostIndex: -1, angle: 0 };
      // ghost preview: above the stack for joint 0, below the joint otherwise
      const ghost = this.makeGhost(h.def);
      ghost.position.y =
        best === 0
          ? this.jointYs[0] + h.def.height / 2
          : this.jointYs[best] - h.def.height / 2;
      this.ghostHolder.add(ghost);
      this.markerHighlight(best);
    } else {
      // radial: hit an eligible host's hull
      const eligible = this.partMeshes.filter((p) =>
        canHostRadials(this.craft.slots[p.slotIndex].def),
      );
      const hits = this.raycaster.intersectObjects(
        eligible.map((p) => p.mesh),
        true,
      );
      if (hits.length === 0) return;
      let obj: THREE.Object3D | null = hits[0].object;
      let hostIndex = -1;
      while (obj) {
        const found = eligible.find((p) => p.mesh === obj);
        if (found) {
          hostIndex = found.slotIndex;
          break;
        }
        obj = obj.parent;
      }
      if (hostIndex < 0) return;
      // azimuth from the hit point (undo the holder's spin)
      const local = this.rocketHolder.worldToLocal(hits[0].point.clone());
      const angle = Math.atan2(local.z, local.x);
      this.snap = { kind: 'surface', jointIndex: -1, hostIndex, angle };
      // ghost ring: one translucent copy per symmetric placement
      const host = this.craft.slots[hostIndex];
      const hostR =
        host.def.type === 'capsule' ? host.def.radius * 0.62 : host.def.radius;
      const hostCenterY = this.slotCenterY(hostIndex);
      const hostBottom = hostCenterY - host.def.height / 2;
      for (let k = 0; k < h.symmetry; k++) {
        const a = angle + (k / h.symmetry) * Math.PI * 2;
        const type = h.def.type;
        const offset =
          type === 'fin'
            ? hostR + 0.02
            : type === 'legs'
              ? hostR + 0.08
              : type === 'rcs'
                ? hostR + h.def.radius * 0.6
                : hostR + h.def.radius + 0.04;
        const cy =
          type === 'srb'
            ? hostBottom - 0.4 + h.def.height / 2
            : type === 'fin'
              ? hostBottom + h.def.height * 0.55
              : type === 'legs'
                ? hostBottom + h.def.height * 0.5
                : hostCenterY;
        const ghost = this.makeGhost(h.def);
        ghost.position.set(Math.cos(a) * offset, cy, Math.sin(a) * offset);
        if (type === 'fin' || type === 'legs' || type === 'rcs') {
          ghost.rotation.y = -a;
        }
        // ghosts live in holder space (they follow the craft's spin)
        this.ghostHolder.add(ghost);
      }
      this.ghostHolder.rotation.y = this.rocketHolder.rotation.y;
    }
  }

  private makeGhost(def: PartDef): THREE.Group {
    const g = buildPartMesh(def, false);
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = (mesh.material as THREE.MeshStandardMaterial).clone();
      m.transparent = true;
      m.opacity = 0.55;
      m.emissive = new THREE.Color(0x2a9d4f);
      m.emissiveIntensity = 0.8;
      m.depthWrite = false;
      mesh.material = m;
    });
    return g;
  }

  private markerHighlight(joint: number): void {
    this.markerHolder.children.forEach((m, i) => {
      const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = i === joint ? 0.95 : 0.35;
      m.scale.setScalar(i === joint ? 1.3 : 1);
    });
  }

  /** World y of a slot's center (visual convention: stack bottom at y=0). */
  private slotCenterY(index: number): number {
    let y = this.craftHeight;
    for (let i = 0; i < index; i++) y -= this.craft.slots[i].def.height;
    return y - this.craft.slots[index].def.height / 2;
  }

  // ---------------- UI panels ----------------

  private setPaused(p: boolean): void {
    this.paused = p;
    $('pause-menu').classList.toggle('hidden', !p);
    if (p) {
      AUDIO.syncSliders('pv-music', 'pv-sfx');
      $('pause-ut').textContent = `UT ${fmtTime(STATE.t)}`;
      $('pause-resume').onclick = () => this.setPaused(false);
      for (const id of ['pause-revert', 'pause-recover', 'pause-tovab', 'pause-terminate']) {
        $(id).style.display = 'none';
      }
      $('pause-sc').style.display = '';
      $('pause-sc').textContent = 'Space Center';
      $('pause-sc').onclick = () => this.host.toSpaceCenter();
    }
  }

  private refreshMissions(): void {
    const panel = $('missions-panel');
    const list = $('missions-list');
    panel.classList.toggle('hidden', STATE.vessels.length === 0);
    list.innerHTML = '';
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
          this.refreshMissions();
        } else {
          this.host.flyVessel(v);
        }
      });
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  private bind(): void {
    $('sample-btn').addEventListener('click', () => {
      // Load the orbital sample once its parts are unlocked; the starter
      // hopper otherwise (it can reach space and come home for science).
      const orbitalOk = sampleParts(SAMPLE_ROCKET).every((d) => STATE.isUnlocked(d));
      this.craft = sampleToDesign(orbitalOk ? SAMPLE_ROCKET : SAMPLE_STARTER);
      if (!orbitalOk)
        showToast('Starter hopper loaded — unlock more parts for the orbital rocket');
      this.discardHolding();
      this.refresh();
    });
    $('clear-btn').addEventListener('click', () => {
      this.craft = emptyCraft();
      this.discardHolding();
      this.refresh();
    });
    $('launch-btn').addEventListener('click', () => {
      this.discardHolding(); // anything still on the cursor goes back in the bin
      if (this.canLaunch()) this.host.launchVessel(this.craft);
    });
    $('vab-back').addEventListener('click', () => this.host.toSpaceCenter());
    $('hold-mode').addEventListener('click', () => this.toggleHoldMode());
    $('stage-add').addEventListener('click', () => {
      this.craft.stages.push([]);
      this.refreshStages();
    });
    $('stage-reset').addEventListener('click', () => {
      this.craft.stages = defaultStages(this.craft.slots);
      this.refreshStages();
      showToast('Stage sequence reset to automatic');
    });
  }

  private canLaunch(): boolean {
    const hasCapsule = this.craft.slots.some((s) => s.def.type === 'capsule');
    const hasEngine = this.craft.slots.some(
      (s) =>
        s.def.type === 'engine' ||
        s.def.type === 'srb' ||
        s.radials.some((r) => r.def.type === 'srb'),
    );
    return hasCapsule && hasEngine;
  }

  // ---------------- refresh ----------------

  private refresh(): void {
    this.refreshPalette();
    this.refreshStats();
    this.refreshStages();
    this.refreshHoldHud();
    this.rebuildCraftVisual();
  }

  private rebuildCraftVisual(): void {
    this.rocketHolder.clear();
    this.markerHolder.clear();
    this.partMeshes = [];
    this.radialMeshes = [];

    const slots = this.craft.slots;
    this.craftHeight = slots.reduce((s, x) => s + x.def.height, 0);

    if (slots.length > 0) {
      const expanded: Array<{
        def: PartDef;
        hostIndex: number;
        groupUid: number;
        deployed?: boolean;
      }> = [];
      slots.forEach((s, i) => {
        for (const g of s.radials) {
          for (let k = 0; k < g.count; k++) {
            expanded.push({ def: g.def, hostIndex: i, groupUid: g.uid });
          }
        }
      });
      const vis = buildRocketVisual(
        slots.map((s) => ({ def: s.def })),
        expanded,
      );
      vis.group.position.y = vis.height / 2;
      this.rocketHolder.add(vis.group);
      vis.partGroups.forEach((mesh, i) => this.partMeshes.push({ mesh, slotIndex: i }));
      for (const r of vis.radialMeshes) {
        if (r.groupUid != null) {
          this.radialMeshes.push({ mesh: r.mesh, groupUid: r.groupUid });
        }
      }
    }

    // stack joints: 0 = above the top part … N = below the bottom part
    this.jointYs = [];
    let y = this.craftHeight;
    this.jointYs.push(y);
    for (const s of slots) {
      y -= s.def.height;
      this.jointYs.push(y);
    }
    // snap markers (visible while a stack part is held)
    const ringGeo = new THREE.TorusGeometry(0.85, 0.045, 8, 32);
    for (const jy of this.jointYs) {
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0x7fd4ff,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = jy;
      this.markerHolder.add(ring);
    }
  }

  private refreshPalette(): void {
    const palette = $('palette-list');
    palette.innerHTML = '';
    for (const cat of CATEGORIES) {
      const header = document.createElement('div');
      header.className = 'palette-cat';
      header.textContent = cat.label;
      palette.appendChild(header);
      const grid = document.createElement('div');
      grid.className = 'palette-grid';
      palette.appendChild(grid);
      for (const def of PARTS.filter((p) => cat.types.includes(p.type))) {
        const unlocked = STATE.isUnlocked(def);
        const btn = document.createElement('button');
        btn.className = 'part-card' + (unlocked ? '' : ' locked');
        btn.title = `${def.name} — ${def.info}`;
        const tag =
          def.mount === 'radial' ? '◎' : def.mount === 'both' ? '◎/▮' : '';
        btn.innerHTML =
          `<span class="pname">${def.name.replace(/"|Engine|Fuel /g, '')}</span>` +
          (unlocked
            ? `<span class="ptag">${tag}</span>`
            : `<span class="lock">🔒${def.cost}✦</span>`);
        btn.addEventListener('click', () => {
          if (STATE.isUnlocked(def)) {
            this.grab({
              def,
              mode:
                def.mount === 'radial'
                  ? 'radial'
                  : def.mount === 'both' && def.type === 'srb'
                    ? 'radial'
                    : 'stack',
              symmetry: 2,
            });
          } else if (STATE.unlockPart(def)) {
            showToast(`Unlocked ${def.name}!`);
            this.refresh();
          } else {
            showToast(`Need ${def.cost} ✦ science to unlock ${def.name}`);
          }
        });
        grid.appendChild(btn);
      }
    }
  }

  private refreshHoldHud(): void {
    const hud = $('hold-hud');
    const h = this.holding;
    hud.classList.toggle('hidden', !h);
    if (!h) return;
    $('hold-name').textContent = h.def.name;
    $('hold-mode-row').style.display = h.def.mount === 'both' ? '' : 'none';
    $('hold-mode').textContent = h.mode.toUpperCase();
    $('hold-sym-row').style.display = h.mode === 'radial' ? '' : 'none';
    const btns = $('hold-sym-btns');
    btns.innerHTML = '';
    for (let n = 1; n <= 4; n++) {
      const b = document.createElement('button');
      b.className = 'mini-btn' + (h.symmetry === n ? ' active' : '');
      b.textContent = `×${n}`;
      b.addEventListener('click', () => this.setSymmetry(n));
      btns.appendChild(b);
    }
  }

  private refreshStats(): void {
    const stats = $('vab-stats');
    const { mass, height, partCount } = designTotals(this.craft);
    const modeRow =
      STATE.mode === 'freedom'
        ? `<div class="srow"><span>Mode</span><b>SANDBOX</b></div>`
        : `<div class="srow"><span>Science</span><b>✦ ${STATE.science}</b></div>`;
    let html = `
      ${modeRow}
      <div class="srow"><span>Parts</span><b>${partCount}</b></div>
      <div class="srow"><span>Height</span><b>${height.toFixed(1)} m</b></div>
      <div class="srow"><span>Mass</span><b>${fmtMass(mass)}</b></div>`;
    const stages = computeStageStats(this.craft).filter((s) => s.dv > 0 || s.twr > 0);
    let total = 0;
    for (const s of stages) {
      total += s.dv;
      const twrWarn = s.twr > 0 && s.twr <= 1 && s.index === stages[0]?.index ? ' warn' : '';
      html += `<div class="srow${twrWarn}"><span>Stage ${s.index} Δv / TWR</span><b>${s.dv.toFixed(0)} m/s · ${s.twr.toFixed(2)}</b></div>`;
    }
    html += `<div class="srow"><span>Total Δv (vac)</span><b>${total.toFixed(0)} m/s</b></div>`;
    if (!this.craft.slots.some((s) => s.def.type === 'capsule'))
      html += `<div class="warn">⚠ needs a capsule</div>`;
    if (!this.canLaunch() && this.craft.slots.length > 0)
      html += `<div class="warn">⚠ needs an engine or boosters</div>`;
    const first = stages[0];
    if (first && first.twr > 0 && first.twr <= 1)
      html += `<div class="warn">⚠ first-stage TWR ≤ 1 — it won't lift off</div>`;
    stats.innerHTML = html;

    ($('launch-btn') as HTMLButtonElement).disabled = !this.canLaunch();
  }

  /**
   * Slots to use when labelling stage chips — includes any piece the cursor
   * is carrying (its chips stay in the list while it's airborne).
   */
  private labelSlots(): CraftSlot[] {
    const h = this.holding;
    if (h?.slotPayload) return [...this.craft.slots, h.slotPayload];
    if (h?.groupPayload) {
      return [
        ...this.craft.slots,
        { uid: -1, def: h.def, radials: [h.groupPayload] },
      ];
    }
    return this.craft.slots;
  }

  /** Editable stage list: chips are draggable between stage boxes. */
  private refreshStages(): void {
    const wrap = $('stage-list');
    wrap.innerHTML = '';
    if (this.craft.slots.length === 0 && !this.holding) {
      wrap.innerHTML = '<div class="stack-empty">Add parts to build a stage sequence.</div>';
      return;
    }
    const slots = this.labelSlots();

    const moveChip = (fromS: number, fromA: number, toS: number) => {
      const action = this.craft.stages[fromS]?.splice(fromA, 1)[0];
      if (!action) return;
      (this.craft.stages[toS] ??= []).push(action);
      this.craft.stages = this.craft.stages.filter(
        (st, i) => st.length > 0 || i === toS,
      );
      this.refreshStages();
    };

    const makeDropTarget = (
      el: HTMLElement,
      onDrop: (fromS: number, fromA: number) => void,
    ) => {
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('dragover');
      });
      el.addEventListener('dragleave', () => el.classList.remove('dragover'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('dragover');
        const ref = e.dataTransfer?.getData('text/plain');
        if (!ref) return;
        const [fs, fa] = ref.split(':').map(Number);
        onDrop(fs, fa);
      });
    };

    this.craft.stages.forEach((stage, si) => {
      // slim separator: drop here to create a NEW stage at this position
      const sep = document.createElement('div');
      sep.className = 'stage-sep';
      sep.title = 'Drop a chip here to insert a new stage';
      makeDropTarget(sep, (fs, fa) => {
        this.craft.stages.splice(si, 0, []);
        // inserting shifted every stage index at or after si
        moveChip(fs >= si ? fs + 1 : fs, fa, si);
      });
      wrap.appendChild(sep);

      const box = document.createElement('div');
      box.className = 'stage-box';
      const head = document.createElement('div');
      head.className = 'stage-head';
      head.innerHTML = `<b>STAGE ${si + 1}</b><span class="hint">${si === 0 ? 'fires first' : ''}</span>`;
      box.appendChild(head);
      if (stage.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'stage-empty-chip';
        empty.textContent = 'empty — drop chips here';
        box.appendChild(empty);
      }
      stage.forEach((action, ai) => {
        const chip = document.createElement('div');
        chip.className = `chip chip-${action.kind}`;
        chip.textContent = actionLabel(slots, action);
        chip.draggable = true;
        chip.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('text/plain', `${si}:${ai}`);
          chip.classList.add('dragging');
        });
        chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
        box.appendChild(chip);
      });
      makeDropTarget(box, (fs, fa) => moveChip(fs, fa, si));
      wrap.appendChild(box);
    });

    // tail separator: drop to append a new final stage
    const tail = document.createElement('div');
    tail.className = 'stage-sep';
    tail.title = 'Drop a chip here to add a final stage';
    makeDropTarget(tail, (fs, fa) => {
      this.craft.stages.push([]);
      moveChip(fs, fa, this.craft.stages.length - 1);
    });
    wrap.appendChild(tail);
  }

  // ---------------- frame ----------------

  update(dt: number): void {
    if (!this.paused) {
      // The world keeps turning while you build.
      STATE.t += dt;
      STATE.advanceInactive(dt, null);
      this.missionTimer += dt;
      if (this.missionTimer > 1) {
        this.missionTimer = 0;
        this.refreshMissions();
      }
      if (this.autoSpin && !this.holding) this.yaw += dt * 0.35;
    }
    this.rocketHolder.rotation.y = this.yaw;
    this.markerHolder.visible = !!this.holding && this.holding.mode === 'stack';
    if (this.holding) this.updateSnap();

    const h = Math.max(4, this.craftHeight);
    const dist = (h + 6) * this.zoom;
    this.camera.position.set(
      Math.sin(0.6) * dist,
      h * 0.62 * this.zoom + 1.5,
      Math.cos(0.6) * dist,
    );
    this.camera.lookAt(0, h * 0.45, 0);
    this.host.renderer.render(this.scene, this.camera);
  }
}
