import * as THREE from 'three';
import { AUDIO } from '../audio';
import { GameHost, GameScene } from '../host';
import { buildRocketVisual } from '../render/rocketMesh';
import { STATE } from '../state';
import { $, fmtDist, fmtMass, fmtTime } from '../util/format';
import { showToast } from '../util/toast';
import {
  BOOSTER_DEF_ID,
  canHostBoosters,
  canHostChutes,
  CHUTE_DEF_ID,
  CraftPart,
  PART_BY_ID,
  PARTS,
  PartDef,
  SAMPLE_ROCKET,
  SAMPLE_STARTER,
} from '../vessel/parts';
import { computeStageStats, describeStages } from '../vessel/vessel';

const CATEGORIES: Array<{ label: string; types: string[] }> = [
  { label: 'Command & Recovery', types: ['capsule', 'parachute', 'dock', 'shield'] },
  { label: 'Propulsion', types: ['tank', 'engine', 'srb'] },
  { label: 'Structural', types: ['decoupler'] },
];

export class VABScene implements GameScene {
  private host: GameHost;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  private rocketHolder = new THREE.Group();
  private stack: CraftPart[] = [];
  private bound = false;
  private paused = false;
  private missionTimer = 0;

  // camera controls
  private yaw = 0;
  private zoom = 1;
  private dragging = false;
  private lastX = 0;
  private autoSpin = true;
  private onPointerDown = (e: PointerEvent) => {
    this.dragging = true;
    this.autoSpin = false;
    this.lastX = e.clientX;
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.yaw += (e.clientX - this.lastX) * 0.008;
    this.lastX = e.clientX;
  };
  private onPointerUp = () => (this.dragging = false);
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom = THREE.MathUtils.clamp(this.zoom * Math.pow(1.1, e.deltaY * 0.01), 0.4, 2.6);
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
    this.onResize();
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
    this.paused = false;
    this.refresh();
    this.refreshMissions();
  }

  exit(): void {
    $('vab-ui').classList.add('hidden');
    $('pause-menu').classList.add('hidden');
    const canvas = this.host.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Escape') this.setPaused(!this.paused);
  }

  onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

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
      const orbitalOk = SAMPLE_ROCKET.every((id) => STATE.isUnlocked(PART_BY_ID[id]));
      this.stack = (orbitalOk ? SAMPLE_ROCKET : SAMPLE_STARTER).map((id) => ({
        def: PART_BY_ID[id],
        boosters: 0,
        chutes: 0,
      }));
      if (!orbitalOk)
        showToast('Starter hopper loaded — unlock more parts for the orbital rocket');
      this.refresh();
    });
    $('clear-btn').addEventListener('click', () => {
      this.stack = [];
      this.refresh();
    });
    $('launch-btn').addEventListener('click', () => {
      if (this.canLaunch()) this.host.launchVessel(this.stack.map((c) => ({ ...c })));
    });
    $('vab-back').addEventListener('click', () => this.host.toSpaceCenter());
  }

  private canLaunch(): boolean {
    return (
      this.stack.some((c) => c.def.type === 'capsule') &&
      this.stack.some(
        (c) => c.def.type === 'engine' || c.def.type === 'srb' || c.boosters > 0,
      )
    );
  }

  private addPart(def: PartDef): void {
    this.stack.push({ def, boosters: 0, chutes: 0 });
    this.refresh();
  }

  private refresh(): void {
    this.refreshPalette();
    this.refreshStack();
    this.refreshStats();

    // 3D preview
    this.rocketHolder.clear();
    if (this.stack.length > 0) {
      const boosters: Array<{ def: PartDef; hostIndex: number }> = [];
      const srb = PART_BY_ID[BOOSTER_DEF_ID];
      const chute = PART_BY_ID[CHUTE_DEF_ID];
      this.stack.forEach((c, i) => {
        for (let k = 0; k < c.boosters; k++) boosters.push({ def: srb, hostIndex: i });
        for (let k = 0; k < c.chutes; k++) boosters.push({ def: chute, hostIndex: i });
      });
      const { group, height: h } = buildRocketVisual(
        this.stack.map((c) => ({ def: c.def })),
        boosters,
      );
      group.position.y = h / 2;
      this.rocketHolder.add(group);
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
      for (const def of PARTS.filter((p) => cat.types.includes(p.type))) {
        const unlocked = STATE.isUnlocked(def);
        const btn = document.createElement('button');
        btn.className = 'part-btn' + (unlocked ? '' : ' locked');
        const lockTag = unlocked ? '' : ` <span class="lock">🔒 ${def.cost} ✦</span>`;
        btn.innerHTML = `<span class="pname">${def.name}${lockTag}</span><span class="pinfo">${def.info}</span>`;
        btn.addEventListener('click', () => {
          if (STATE.isUnlocked(def)) {
            this.addPart(def);
          } else if (STATE.unlockPart(def)) {
            showToast(`Unlocked ${def.name}!`);
            this.refresh();
          } else {
            showToast(`Need ${def.cost} ✦ science to unlock ${def.name}`);
          }
        });
        palette.appendChild(btn);
      }
    }
  }

  private refreshStack(): void {
    const list = $('stack-list');
    list.innerHTML = '';
    if (this.stack.length === 0) {
      list.innerHTML =
        '<div class="stack-empty">No parts yet — click parts on the left, or load the sample rocket.</div>';
    }
    const srbDef = PART_BY_ID[BOOSTER_DEF_ID];
    this.stack.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'stack-item';
      const label = document.createElement('span');
      label.innerHTML =
        c.def.name +
        (c.boosters ? ` <b class="bcount">+${c.boosters}◎</b>` : '') +
        (c.chutes ? ` <b class="bcount">+${c.chutes}☂</b>` : '');
      row.appendChild(label);

      const controls = document.createElement('span');
      controls.className = 'stack-controls';
      if (canHostBoosters(c.def)) {
        const bBtn = document.createElement('button');
        bBtn.className = 'mini-btn';
        bBtn.textContent = '◎+';
        bBtn.title = 'Attach radial side boosters (0 → 2 → 4)';
        bBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!STATE.isUnlocked(srbDef)) {
            showToast(`Side boosters need the ${srbDef.name} unlocked (${srbDef.cost} ✦)`);
            return;
          }
          c.boosters = c.boosters >= 4 ? 0 : c.boosters + 2;
          this.refresh();
        });
        controls.appendChild(bBtn);
      }
      if (canHostChutes(c.def)) {
        const cBtn = document.createElement('button');
        cBtn.className = 'mini-btn';
        cBtn.textContent = '☂+';
        cBtn.title = 'Attach radial parachutes (0 → 2 → 0)';
        cBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          c.chutes = c.chutes >= 2 ? 0 : 2;
          this.refresh();
        });
        controls.appendChild(cBtn);
      }
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      controls.appendChild(x);
      row.appendChild(controls);
      row.title = 'Click to remove';
      row.addEventListener('click', () => {
        this.stack.splice(i, 1);
        this.refresh();
      });
      list.appendChild(row);
    });
  }

  private refreshStats(): void {
    const stats = $('vab-stats');
    const srb = PART_BY_ID[BOOSTER_DEF_ID];
    const chuteDef = PART_BY_ID[CHUTE_DEF_ID];
    const mass = this.stack.reduce(
      (s, c) =>
        s +
        c.def.dryMass +
        (c.def.fuel ?? 0) +
        c.boosters * (srb.dryMass + (srb.fuel ?? 0)) +
        c.chutes * chuteDef.dryMass,
      0,
    );
    const height = this.stack.reduce((s, c) => s + c.def.height, 0);
    const modeRow =
      STATE.mode === 'freedom'
        ? `<div class="srow"><span>Mode</span><b>SANDBOX</b></div>`
        : `<div class="srow"><span>Science</span><b>✦ ${STATE.science}</b></div>`;
    let html = `
      ${modeRow}
      <div class="srow"><span>Parts</span><b>${this.stack.length + this.stack.reduce((s, c) => s + c.boosters + c.chutes, 0)}</b></div>
      <div class="srow"><span>Height</span><b>${height.toFixed(1)} m</b></div>
      <div class="srow"><span>Mass</span><b>${fmtMass(mass)}</b></div>`;
    const stages = computeStageStats(this.stack).filter((s) => s.dv > 0 || s.twr > 0);
    let total = 0;
    for (const s of stages) {
      total += s.dv;
      const twrWarn = s.index === 1 && s.twr > 0 && s.twr <= 1 ? ' warn' : '';
      html += `<div class="srow${twrWarn}"><span>Stage ${s.index} Δv / TWR</span><b>${s.dv.toFixed(0)} m/s · ${s.twr.toFixed(2)}</b></div>`;
    }
    html += `<div class="srow"><span>Total Δv (vac)</span><b>${total.toFixed(0)} m/s</b></div>`;
    if (!this.stack.some((c) => c.def.type === 'capsule'))
      html += `<div class="warn">⚠ needs a capsule</div>`;
    if (!this.canLaunch() && this.stack.length > 0)
      html += `<div class="warn">⚠ needs an engine or boosters</div>`;
    const first = computeStageStats(this.stack)[0];
    if (first && first.twr > 0 && first.twr <= 1)
      html += `<div class="warn">⚠ first-stage TWR ≤ 1 — it won't lift off</div>`;
    stats.innerHTML = html;

    // Stage sequence preview (what each Space press does in flight)
    const seq = describeStages(this.stack);
    $('vab-stages').innerHTML =
      this.stack.length === 0 || seq.length === 0
        ? ''
        : `<h3>Stage sequence</h3>` +
          seq.map((s, i) => `<div class="stage-step"><b>${i + 1}</b> ${s}</div>`).join('');

    ($('launch-btn') as HTMLButtonElement).disabled = !this.canLaunch();
  }

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
      if (this.autoSpin) this.yaw += dt * 0.35;
    }
    this.rocketHolder.rotation.y = this.yaw;
    const h = Math.max(4, this.stack.reduce((s, c) => s + c.def.height, 0));
    const dist = (h + 6) * this.zoom;
    this.camera.position.set(Math.sin(0.6) * dist, h * 0.62 * this.zoom + 1.5, Math.cos(0.6) * dist);
    this.camera.lookAt(0, h * 0.45, 0);
    this.host.renderer.render(this.scene, this.camera);
  }
}
