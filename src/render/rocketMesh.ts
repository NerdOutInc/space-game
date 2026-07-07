import * as THREE from 'three';
import { PartDef } from '../vessel/parts';
import { PartInstance } from '../vessel/vessel';

export interface BoosterMount {
  x: number;
  y: number; // bottom of the booster (flame anchor)
  z: number;
}

export interface RocketVisual {
  group: THREE.Group;
  height: number;
  /** One entry per radial booster, in input order. */
  boosterMounts: BoosterMount[];
}

function metal(color: number, rough = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.35 });
}

function buildPartMesh(def: PartDef, deployed: boolean): THREE.Group {
  const g = new THREE.Group();
  const r = def.radius;
  const h = def.height;

  switch (def.type) {
    case 'capsule': {
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, r, h, 24),
        metal(0xd8dde2, 0.4),
      );
      g.add(cone);
      const window = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.22, 0.1),
        new THREE.MeshStandardMaterial({
          color: 0x14202e,
          roughness: 0.1,
          metalness: 0.8,
        }),
      );
      window.position.set(0, h * 0.05, r * 0.72);
      window.rotation.x = -0.28;
      g.add(window);
      break;
    }
    case 'parachute': {
      const can = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.3, h, 16),
        metal(0xd95d2a, 0.6),
      );
      g.add(can);
      if (deployed) {
        const canopy = new THREE.Mesh(
          new THREE.SphereGeometry(5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.MeshStandardMaterial({
            color: 0xe86a2e,
            roughness: 0.9,
            side: THREE.DoubleSide,
          }),
        );
        canopy.position.y = 9;
        g.add(canopy);
        const lineMat = new THREE.LineBasicMaterial({
          color: 0xcccccc,
          transparent: true,
          opacity: 0.7,
        });
        for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          const pts = [
            new THREE.Vector3(0, h / 2, 0),
            new THREE.Vector3(Math.cos(a) * 4.4, 9.6, Math.sin(a) * 4.4),
          ];
          g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
        }
      }
      break;
    }
    case 'tank': {
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, h, 24),
        metal(0xc7cbd1, 0.5),
      );
      g.add(body);
      for (const y of [h / 2 - 0.09, -h / 2 + 0.09]) {
        const ring = new THREE.Mesh(
          new THREE.CylinderGeometry(r * 1.015, r * 1.015, 0.16, 24),
          metal(0x2f3540, 0.7),
        );
        ring.position.y = y;
        g.add(ring);
      }
      break;
    }
    case 'engine': {
      const mount = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.85, r * 0.55, h * 0.45, 20),
        metal(0x555c66, 0.6),
      );
      mount.position.y = h * 0.27;
      g.add(mount);
      const nozzle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.46, h * 0.6, 20, 1, true),
        new THREE.MeshStandardMaterial({
          color: 0x23262c,
          roughness: 0.4,
          metalness: 0.85,
          side: THREE.DoubleSide,
        }),
      );
      nozzle.position.y = -h * 0.18;
      g.add(nozzle);
      break;
    }
    case 'srb': {
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, h * 0.92, 20),
        metal(0x8a4a3a, 0.75),
      );
      body.position.y = h * 0.04;
      g.add(body);
      const nozzle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.32, h * 0.14, 16, 1, true),
        metal(0x23262c, 0.4),
      );
      nozzle.position.y = -h * 0.44;
      g.add(nozzle);
      const tip = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.4, r, h * 0.06, 20),
        metal(0xd8dde2, 0.5),
      );
      tip.position.y = h * 0.47;
      g.add(tip);
      break;
    }
    case 'dock': {
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.74, r * 0.9, h * 0.55, 24),
        metal(0xb8bec6, 0.35),
      );
      base.position.y = -h * 0.2;
      g.add(base);
      const collar = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.52, r * 0.6, h * 0.5, 24),
        metal(0x2a2e35, 0.3),
      );
      collar.position.y = h * 0.22;
      g.add(collar);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.5, 0.05, 10, 28),
        new THREE.MeshStandardMaterial({
          color: 0xffd257,
          roughness: 0.4,
          metalness: 0.7,
          emissive: 0x332200,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = h * 0.45;
      g.add(ring);
      break;
    }
    case 'decoupler': {
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.02, r * 1.02, h, 24),
        metal(0xd7a13c, 0.65),
      );
      g.add(band);
      break;
    }
  }
  return g;
}

/**
 * Build meshes for a part stack (ordered top → bottom), centered vertically
 * on the group's origin, plus any radially-attached side boosters.
 */
export function buildRocketVisual(
  parts: Array<PartInstance | { def: PartDef; deployed?: boolean }>,
  boosters: Array<{ def: PartDef; hostIndex: number }> = [],
): RocketVisual {
  const group = new THREE.Group();
  const height = parts.reduce((s, p) => s + p.def.height, 0);
  const centerY: number[] = new Array(parts.length).fill(0);
  let y = -height / 2;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    const mesh = buildPartMesh(p.def, 'deployed' in p ? !!p.deployed : false);
    centerY[i] = y + p.def.height / 2;
    mesh.position.y = centerY[i];
    group.add(mesh);
    y += p.def.height;
  }

  // Radial boosters: symmetric around the host (±X first, then ±Z)
  const boosterMounts: BoosterMount[] = [];
  const slotCount = new Map<number, number>();
  const ANGLES = [0, Math.PI, Math.PI / 2, (3 * Math.PI) / 2];
  for (const b of boosters) {
    const host = parts[b.hostIndex];
    if (!host) continue;
    const slot = slotCount.get(b.hostIndex) ?? 0;
    slotCount.set(b.hostIndex, slot + 1);
    const a = ANGLES[slot % ANGLES.length];
    const offset = host.def.radius + b.def.radius + 0.06;
    const mesh = buildPartMesh(b.def, false);
    const hostBottom = centerY[b.hostIndex] - host.def.height / 2;
    const cy = hostBottom - 0.4 + b.def.height / 2; // hang slightly below host
    mesh.position.set(Math.cos(a) * offset, cy, Math.sin(a) * offset);
    group.add(mesh);
    boosterMounts.push({
      x: Math.cos(a) * offset,
      y: cy - b.def.height / 2,
      z: Math.sin(a) * offset,
    });
  }
  return { group, height, boosterMounts };
}

/** Additive exhaust cone; scale/flicker it from the flight scene. */
export function buildFlame(): THREE.Mesh {
  const geo = new THREE.ConeGeometry(0.42, 3.2, 16, 1, true);
  geo.rotateX(Math.PI); // apex points down
  geo.translate(0, -1.6, 0); // base sits at the origin (engine nozzle)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffa63d,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}
