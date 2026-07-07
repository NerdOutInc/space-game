import * as THREE from 'three';
import { GameHost, GameScene } from '../host';
import { buildRocketVisual } from '../render/rocketMesh';
import { $, fmtMass } from '../util/format';
import { PartDef, PARTS, PART_BY_ID, SAMPLE_ROCKET } from '../vessel/parts';
import { computeStageStats } from '../vessel/vessel';

export class VABScene implements GameScene {
  private host: GameHost;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  private rocketHolder = new THREE.Group();
  private stack: PartDef[] = [];
  private bound = false;

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
    if (!this.bound) {
      this.bind();
      this.bound = true;
    }
    this.refresh();
  }

  exit(): void {
    $('vab-ui').classList.add('hidden');
  }

  onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  private bind(): void {
    const palette = $('palette-list');
    for (const def of PARTS) {
      const btn = document.createElement('button');
      btn.className = 'part-btn';
      btn.innerHTML = `<span class="pname">${def.name}</span><span class="pinfo">${def.info}</span>`;
      btn.addEventListener('click', () => {
        this.stack.push(def);
        this.refresh();
      });
      palette.appendChild(btn);
    }
    $('sample-btn').addEventListener('click', () => {
      this.stack = SAMPLE_ROCKET.map((id) => PART_BY_ID[id]);
      this.refresh();
    });
    $('clear-btn').addEventListener('click', () => {
      this.stack = [];
      this.refresh();
    });
    $('launch-btn').addEventListener('click', () => {
      if (this.canLaunch()) this.host.toFlight([...this.stack]);
    });
  }

  private canLaunch(): boolean {
    return (
      this.stack.some((d) => d.type === 'capsule') &&
      this.stack.some((d) => d.type === 'engine' || d.type === 'srb')
    );
  }

  private refresh(): void {
    // Stack list
    const list = $('stack-list');
    list.innerHTML = '';
    if (this.stack.length === 0) {
      list.innerHTML = '<div class="stack-empty">No parts yet — click parts on the left, or load the sample rocket.</div>';
    }
    this.stack.forEach((def, i) => {
      const row = document.createElement('div');
      row.className = 'stack-item';
      row.innerHTML = `<span>${def.name}</span><span class="x">✕</span>`;
      row.title = 'Click to remove';
      row.addEventListener('click', () => {
        this.stack.splice(i, 1);
        this.refresh();
      });
      list.appendChild(row);
    });

    // Stats
    const stats = $('vab-stats');
    const mass = this.stack.reduce((s, d) => s + d.dryMass + (d.fuel ?? 0), 0);
    const height = this.stack.reduce((s, d) => s + d.height, 0);
    let html = `
      <div class="srow"><span>Parts</span><b>${this.stack.length}</b></div>
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
    if (!this.stack.some((d) => d.type === 'capsule'))
      html += `<div class="warn">⚠ needs a capsule</div>`;
    if (!this.stack.some((d) => d.type === 'engine' || d.type === 'srb'))
      html += `<div class="warn">⚠ needs an engine</div>`;
    const first = computeStageStats(this.stack)[0];
    if (first && first.twr > 0 && first.twr <= 1)
      html += `<div class="warn">⚠ first-stage TWR ≤ 1 — it won't lift off</div>`;
    stats.innerHTML = html;

    ($('launch-btn') as HTMLButtonElement).disabled = !this.canLaunch();

    // 3D preview
    this.rocketHolder.clear();
    if (this.stack.length > 0) {
      const { group, height: h } = buildRocketVisual(this.stack.map((def) => ({ def })));
      group.position.y = h / 2;
      this.rocketHolder.add(group);
    }
  }

  update(dt: number): void {
    this.rocketHolder.rotation.y += dt * 0.35;
    const h = Math.max(4, this.stack.reduce((s, d) => s + d.height, 0));
    this.camera.position.set(Math.sin(0.6) * (h + 6), h * 0.62 + 1.5, Math.cos(0.6) * (h + 6));
    this.camera.lookAt(0, h * 0.45, 0);
    this.host.renderer.render(this.scene, this.camera);
  }
}
