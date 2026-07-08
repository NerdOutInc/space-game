import * as THREE from 'three';
import { PartDef } from '../vessel/parts';
import { PartInstance } from '../vessel/vessel';

export interface BoosterMount {
  x: number;
  y: number; // bottom of the booster (flame anchor)
  z: number;
}

/** A deployed canopy the flight scene can animate (inflation + sway). */
export interface CanopyAnim {
  group: THREE.Object3D;
  source: { inflate?: number };
  /** Rest orientation (radial chutes tilt outward). */
  base: THREE.Quaternion;
  phase: number;
}

export interface RocketVisual {
  group: THREE.Group;
  height: number;
  /** One entry per radial booster, in input order. */
  boosterMounts: BoosterMount[];
  /** Per-stack-part mesh groups (index-aligned with the parts array). */
  partGroups: THREE.Group[];
  /** Every radial part mesh with its group id (VAB hit-testing). */
  radialMeshes: Array<{ mesh: THREE.Object3D; groupUid?: number }>;
  /** Deployed parachute canopies, ready for animation. */
  canopies: CanopyAnim[];
}

function metal(color: number, rough = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.35 });
}

export function buildPartMesh(def: PartDef, deployed: boolean): THREE.Group {
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
      // white canister with a bright orange dome — visible even radially
      const can = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.88, r, h * 0.85, 16),
        metal(0xe8e4dc, 0.5),
      );
      can.position.y = -h * 0.08;
      g.add(can);
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(r * 0.88, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        metal(0xe86a2e, 0.55),
      );
      cap.scale.y = 0.65;
      cap.position.y = h * 0.34;
      g.add(cap);
      if (deployed) {
        // Canopy + lines live in one group anchored at the canister top, so
        // scaling the group inflates the whole assembly from its attach
        // point (the flight scene animates this from the chute's inflate).
        const canopyGroup = new THREE.Group();
        canopyGroup.name = 'canopy';
        canopyGroup.position.y = h / 2;
        const canopy = new THREE.Mesh(
          new THREE.SphereGeometry(5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.MeshStandardMaterial({
            color: 0xe86a2e,
            roughness: 0.9,
            side: THREE.DoubleSide,
          }),
        );
        canopy.position.y = 8.6;
        canopy.scale.y = 0.62;
        canopyGroup.add(canopy);
        const band = new THREE.Mesh(
          new THREE.SphereGeometry(5.02, 24, 12, 0, Math.PI * 2, Math.PI * 0.32, Math.PI * 0.1),
          new THREE.MeshStandardMaterial({
            color: 0xf2ede4,
            roughness: 0.9,
            side: THREE.DoubleSide,
          }),
        );
        band.position.y = 8.6;
        band.scale.y = 0.62;
        canopyGroup.add(band);
        const lineMat = new THREE.LineBasicMaterial({
          color: 0xcccccc,
          transparent: true,
          opacity: 0.7,
        });
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          const pts = [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(Math.cos(a) * 4.6, 8.4, Math.sin(a) * 4.6),
          ];
          canopyGroup.add(
            new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat),
          );
        }
        g.add(canopyGroup);
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
    case 'shield': {
      // ablative dish: tan structural top, scorched-brown curved bottom
      const top = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r * 1.04, h * 0.45, 24),
        metal(0xc8b08a, 0.7),
      );
      top.position.y = h * 0.2;
      g.add(top);
      const dish = new THREE.Mesh(
        new THREE.SphereGeometry(r * 1.06, 24, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x3a2c22, roughness: 0.95 }),
      );
      dish.scale.y = 0.55;
      dish.position.y = h * 0.05;
      g.add(dish);
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
    case 'nose': {
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, r, h, 24),
        metal(0xd8dde2, 0.45),
      );
      g.add(cone);
      const stripe = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.55, r * 0.75, h * 0.2, 24),
        metal(0xc23b22, 0.5),
      );
      stripe.position.y = h * 0.12;
      g.add(stripe);
      break;
    }
    case 'adapter': {
      const taper = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.68, r, h, 24),
        metal(0x9aa3ad, 0.6),
      );
      g.add(taper);
      break;
    }
    case 'fin': {
      // swept blade extending +X (placement yaws it outward)
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, h, 0.055),
        metal(0xb8442f, 0.6),
      );
      blade.position.x = 0.3;
      blade.rotation.z = -0.22;
      g.add(blade);
      const root = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, h * 0.85, 0.12),
        metal(0x2f3540, 0.7),
      );
      root.position.x = 0.03;
      g.add(root);
      break;
    }
    case 'rcs': {
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.26, 0.26),
        metal(0xe8e4dc, 0.5),
      );
      g.add(block);
      const nozzleMat = metal(0x23262c, 0.4);
      for (const [dy, dz] of [
        [0.16, 0],
        [-0.16, 0],
        [0, 0.16],
        [0, -0.16],
      ]) {
        const noz = new THREE.Mesh(
          new THREE.CylinderGeometry(0.03, 0.055, 0.09, 8),
          nozzleMat,
        );
        noz.position.set(0.06, dy, dz);
        if (dz !== 0) noz.rotation.x = dz > 0 ? -Math.PI / 2 : Math.PI / 2;
        else if (dy < 0) noz.rotation.x = Math.PI;
        g.add(noz);
      }
      break;
    }
    case 'legs': {
      // strut pivots at the top mount; deployed swings it out to a stance
      const mount = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.3, 0.18),
        metal(0x2f3540, 0.7),
      );
      mount.position.y = h * 0.38;
      g.add(mount);
      const strut = new THREE.Group();
      strut.position.y = h * 0.3;
      const upper = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, h * 0.9, 10),
        metal(0xc7cbd1, 0.4),
      );
      upper.position.y = -h * 0.45;
      strut.add(upper);
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.2, 0.07, 12),
        metal(0x2f3540, 0.7),
      );
      foot.position.y = -h * 0.9;
      strut.add(foot);
      // deployed: swing outward (+X) and down for a wide stance
      strut.rotation.z = deployed ? 0.55 : 0.02;
      g.add(strut);
      break;
    }
  }
  return g;
}

/**
 * Build meshes for a part stack (ordered top → bottom), centered vertically
 * on the group's origin, plus any radially-attached parts (boosters, chutes,
 * fins, legs, RCS…). Radials may carry a groupUid so symmetric copies of one
 * attachment spread evenly around their host.
 */
export function buildRocketVisual(
  parts: Array<PartInstance | { def: PartDef; deployed?: boolean }>,
  radials: Array<{
    def: PartDef;
    hostIndex: number;
    deployed?: boolean;
    groupUid?: number;
  }> = [],
): RocketVisual {
  const group = new THREE.Group();
  const height = parts.reduce((s, p) => s + p.def.height, 0);
  const centerY: number[] = new Array(parts.length).fill(0);
  const partGroups: THREE.Group[] = new Array(parts.length);
  const canopies: CanopyAnim[] = [];
  let y = -height / 2;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    const mesh = buildPartMesh(p.def, 'deployed' in p ? !!p.deployed : false);
    centerY[i] = y + p.def.height / 2;
    mesh.position.y = centerY[i];
    group.add(mesh);
    partGroups[i] = mesh;
    const canopy = mesh.getObjectByName('canopy');
    if (canopy) {
      canopies.push({
        group: canopy,
        source: p as { inflate?: number },
        base: new THREE.Quaternion(),
        phase: i * 1.7,
      });
    }
    y += p.def.height;
  }

  // Radial attachments: cluster symmetric copies (same group / same def on
  // one host) and spread each cluster evenly around its host. Successive
  // clusters on a host start at rotated offsets so pairs interleave
  // (boosters ±X, chutes ±Z, …) instead of stacking on one side.
  const boosterMounts: BoosterMount[] = [];
  const radialMeshes: RocketVisual['radialMeshes'] = [];
  type RadialIn = (typeof radials)[number];
  const clusters = new Map<string, RadialIn[]>();
  const clusterOrder: string[] = [];
  radials.forEach((r) => {
    const key = r.groupUid != null ? `g${r.groupUid}` : `h${r.hostIndex}:${r.def.id}`;
    if (!clusters.has(key)) {
      clusters.set(key, []);
      clusterOrder.push(key);
    }
    clusters.get(key)!.push(r);
  });
  const OFFSETS = [0, Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4];
  const hostClusterCount = new Map<number, number>();
  // SRB mounts must be emitted in the same order as the input list (flame
  // anchors index into the vessel's radial-SRB order), so collect per-part.
  const srbMounts = new Map<RadialIn, BoosterMount>();
  for (const key of clusterOrder) {
    const members = clusters.get(key)!;
    const hostIndex = members[0].hostIndex;
    const host = parts[hostIndex];
    if (!host) continue;
    const ordinal = hostClusterCount.get(hostIndex) ?? 0;
    hostClusterCount.set(hostIndex, ordinal + 1);
    const baseA = OFFSETS[ordinal % OFFSETS.length];
    members.forEach((b, k) => {
      const a = baseA + (k / members.length) * Math.PI * 2;
      const type = b.def.type;
      // tapered hosts (capsules) are narrower where radial gear mounts
      const hostR =
        host.def.type === 'capsule' ? host.def.radius * 0.62 : host.def.radius;
      const offset =
        type === 'fin'
          ? hostR + 0.02
          : type === 'legs'
            ? hostR + 0.08
            : type === 'rcs'
              ? hostR + b.def.radius * 0.6
              : hostR + b.def.radius + 0.04;
      const mesh = buildPartMesh(b.def, !!b.deployed);
      const hostBottom = centerY[hostIndex] - host.def.height / 2;
      const cy =
        type === 'srb'
          ? hostBottom - 0.4 + b.def.height / 2 // boosters hang below
          : type === 'fin'
            ? hostBottom + b.def.height * 0.55 // fins ride the host's skirt
            : type === 'legs'
              ? hostBottom + b.def.height * 0.5
              : centerY[hostIndex]; // chutes/RCS sit at the waist
      mesh.position.set(Math.cos(a) * offset, cy, Math.sin(a) * offset);
      // directional radials (fins, legs, RCS) face away from the hull
      if (type === 'fin' || type === 'legs' || type === 'rcs') {
        mesh.rotation.y = -a;
      }
      group.add(mesh);
      radialMeshes.push({ mesh, groupUid: b.groupUid });
      const canopy = mesh.getObjectByName('canopy');
      if (canopy) {
        // radial canopies tilt away from the stack so pairs don't merge
        const base = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)),
          -0.38,
        );
        canopy.quaternion.copy(base);
        canopies.push({
          group: canopy,
          source: b as { inflate?: number },
          base,
          phase: hostIndex * 1.7 + k * 2.3,
        });
      }
      if (type === 'srb') {
        srbMounts.set(b, {
          x: Math.cos(a) * offset,
          y: cy - b.def.height / 2,
          z: Math.sin(a) * offset,
        });
      }
    });
  }
  for (const r of radials) {
    const m = srbMounts.get(r);
    if (m) boosterMounts.push(m);
  }
  return { group, height, boosterMounts, partGroups, radialMeshes, canopies };
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
