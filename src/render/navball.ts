import * as THREE from 'three';
import { $ } from '../util/format';
import { Vessel } from '../vessel/vessel';

export const NAVBALL_SIZE = 170; // css px, must match #nb-ring

/**
 * Equirect navball texture painted in the local-horizon frame:
 * ball-local +Y = zenith, +X = north, +Z = east.
 * (Three's sphere UVs put u=0 at -X, u=0.25 at +Z, u=0.5 at +X, u=0.75 at -Z.)
 */
function makeNavballTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;

  const sky = ctx.createLinearGradient(0, 0, 0, H / 2);
  sky.addColorStop(0, '#2b6fb8');
  sky.addColorStop(1, '#79b7ef');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H / 2);
  const gnd = ctx.createLinearGradient(0, H / 2, 0, H);
  gnd.addColorStop(0, '#a5642c');
  gnd.addColorStop(1, '#5e3716');
  ctx.fillStyle = gnd;
  ctx.fillRect(0, H / 2, W, H / 2);

  const yOfLat = (lat: number) => (1 - (lat + 90) / 180) * H;

  // meridians + parallels
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const x = (i / 12) * W;
    ctx.beginPath();
    ctx.moveTo(x, yOfLat(80));
    ctx.lineTo(x, yOfLat(-80));
    ctx.stroke();
  }
  for (const lat of [-60, -30, 30, 60]) {
    ctx.beginPath();
    ctx.moveTo(0, yOfLat(lat));
    ctx.lineTo(W, yOfLat(lat));
    ctx.stroke();
  }

  // horizon
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  // pitch labels
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 26px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const lat of [-60, -30, 30, 60]) {
    for (const x of [W * 0.125, W * 0.375, W * 0.625, W * 0.875]) {
      ctx.fillText(`${Math.abs(lat)}`, x, yOfLat(lat));
    }
  }

  // cardinal directions along the horizon (u: 0=S, .25=E, .5=N, .75=W)
  ctx.font = 'bold 44px monospace';
  const marks: Array<[number, string]> = [
    [0, 'S'],
    [W * 0.25, 'E'],
    [W * 0.5, 'N'],
    [W * 0.75, 'W'],
    [W, 'S'],
  ];
  for (const [x, s] of marks) {
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s, x, H / 2 - 34);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeMarkerTexture(color: string, retro: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(32, 32, 22, 0, Math.PI * 2);
  ctx.stroke();
  if (retro) {
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4]) {
      ctx.beginPath();
      ctx.moveTo(32 - Math.cos(a) * 20, 32 - Math.sin(a) * 20);
      ctx.lineTo(32 + Math.cos(a) * 20, 32 + Math.sin(a) * 20);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.arc(32, 32, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(c);
}

const _up = new THREE.Vector3();
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _nose = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _qM = new THREE.Quaternion();
const _qMinv = new THREE.Quaternion();
const _qRel = new THREE.Quaternion();
const _ballQ = new THREE.Quaternion();

export class Navball {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
  private ball: THREE.Mesh;
  private pro: THREE.Sprite;
  private retro: THREE.Sprite;
  /** Fixed rotation: vessel-local frame → navball view (nose to ball center). */
  private C = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 2,
  );

  constructor() {
    this.camera.position.set(0, 0, 3.05);
    this.camera.lookAt(0, 0, 0);
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.MeshBasicMaterial({ map: makeNavballTexture() }),
    );
    this.scene.add(this.ball);
    this.pro = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeMarkerTexture('#c8f64c', false) }),
    );
    this.retro = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeMarkerTexture('#ff8a5c', true) }),
    );
    this.pro.scale.set(0.34, 0.34, 1);
    this.retro.scale.set(0.34, 0.34, 1);
    this.scene.add(this.pro, this.retro);
  }

  update(v: Vessel): void {
    // Local horizon basis: x=north, y=up(zenith), z=east
    _up.copy(v.pos).normalize();
    _spin.set(0, v.body.spinRate, 0);
    _east.crossVectors(_spin, _up);
    if (_east.lengthSq() < 1e-12) _east.set(0, 0, 1);
    _east.normalize();
    _north.crossVectors(_up, _east).normalize();
    _mat.makeBasis(_north, _up, _east);
    _qM.setFromRotationMatrix(_mat);
    _qMinv.copy(_qM).invert();

    // Vessel attitude expressed in the horizon frame, then ball rotation.
    _qRel.copy(_qMinv).multiply(v.q);
    _ballQ.copy(_qRel).invert().premultiply(this.C);
    this.ball.quaternion.copy(_ballQ);

    // Prograde/retrograde markers (surface velocity low, orbital high)
    const alt = v.pos.length() - v.body.radius;
    if (alt < 45_000) {
      _vel.crossVectors(_spin, v.pos).multiplyScalar(-1).add(v.vel); // v - ω×r
    } else {
      _vel.copy(v.vel);
    }
    if (_vel.lengthSq() > 4) {
      _vel.normalize().applyQuaternion(_qMinv).applyQuaternion(_ballQ);
      this.pro.visible = true;
      this.retro.visible = true;
      this.pro.position.copy(_vel).multiplyScalar(1.02);
      this.retro.position.copy(_vel).multiplyScalar(-1.02);
    } else {
      this.pro.visible = false;
      this.retro.visible = false;
    }

    // Heading / pitch readout
    _nose.set(0, 1, 0).applyQuaternion(_qRel);
    const pitch = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(_nose.y, -1, 1)),
    );
    const horiz = Math.hypot(_nose.x, _nose.z);
    $('nb-pit').textContent = `PIT ${pitch.toFixed(0)}°`;
    if (horiz > 0.02) {
      const hdg = (THREE.MathUtils.radToDeg(Math.atan2(_nose.z, _nose.x)) + 360) % 360;
      $('nb-hdg').textContent = `HDG ${hdg.toFixed(0).padStart(3, '0')}°`;
    } else {
      $('nb-hdg').textContent = 'HDG —';
    }
  }

  /** Draw the ball into a scissored square at the bottom-center of the canvas. */
  render(renderer: THREE.WebGLRenderer): void {
    const size = NAVBALL_SIZE;
    const x = Math.round(window.innerWidth / 2 - size / 2);
    const y = 12;
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, size, size);
    renderer.setViewport(x, y, size, size);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.autoClear = prevAuto;
  }

  dispose(): void {
    this.ball.geometry.dispose();
    ((this.ball.material as THREE.MeshBasicMaterial).map as THREE.Texture)?.dispose();
    (this.ball.material as THREE.Material).dispose();
    for (const s of [this.pro, this.retro]) {
      s.material.map?.dispose();
      s.material.dispose();
    }
  }
}
