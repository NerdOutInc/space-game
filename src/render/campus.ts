import * as THREE from 'three';

function building(w: number, h: number, d: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85 }),
  );
  m.position.y = h / 2;
  return m;
}

/**
 * The Zenith Space Center campus with the LAUNCH PAD AT THE ORIGIN, so the
 * flight scene can drop it exactly at the pad site on Gaia. Includes
 * emissive floodlights so the facility reads at night.
 *
 * `withApron` adds a local ground disc at the analytic plateau height —
 * the planet mesh's vertices are ~20 km apart, so its interpolated surface
 * can dip below the true ground and leave the buildings hovering.
 */
export function buildCampus(withApron = false): THREE.Group {
  const g = new THREE.Group();

  if (withApron) {
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(2600, 48),
      new THREE.MeshStandardMaterial({ color: 0x35603b, roughness: 1 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = 1.8; // campus local 1.8 = analytic ground level
    g.add(apron);
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(2600, 2680, 60, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x2c5232, roughness: 1, side: THREE.DoubleSide }),
    );
    skirt.position.y = 1.8 - 30;
    g.add(skirt);
  }

  // Launch pad
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(16, 18, 2.4, 32),
    new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.85 }),
  );
  pad.position.y = 1.2;
  g.add(pad);
  const tower = building(3, 34, 3, 0x8a2f2a);
  tower.position.set(14, 17, -10);
  g.add(tower);

  // VAB
  const vab = building(46, 64, 40, 0xb8bec6);
  vab.position.set(-115, 32, -35);
  g.add(vab);
  const stripe = building(46.6, 12, 40.6, 0x2e62c9);
  stripe.position.set(-115, 40, -35);
  g.add(stripe);

  // Tracking station
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(9, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.6 }),
  );
  dome.position.set(-85, 0, 80);
  g.add(dome);
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(7, 24, 12, 0, Math.PI * 2, 0, Math.PI / 3),
    new THREE.MeshStandardMaterial({
      color: 0xe8eef4,
      roughness: 0.4,
      side: THREE.DoubleSide,
    }),
  );
  dish.position.set(-102, 8, 86);
  dish.rotation.z = Math.PI / 2.6;
  g.add(dish);
  const mast = building(1.2, 8, 1.2, 0x555c66);
  mast.position.set(-102, 4, 86);
  g.add(mast);

  // Fuel farm
  for (const [x, z] of [
    [-40, 60],
    [-32, 64],
    [-36, 72],
  ] as const) {
    const tank = new THREE.Mesh(
      new THREE.CylinderGeometry(4, 4, 10, 16),
      new THREE.MeshStandardMaterial({ color: 0xc7cbd1, roughness: 0.5 }),
    );
    tank.position.set(x, 5, z);
    g.add(tank);
  }

  // Floodlights: four poles ringing the pad, plus VAB & tracking site
  const headMat = new THREE.MeshStandardMaterial({
    color: 0x333333,
    emissive: 0xfff2cc,
    emissiveIntensity: 1.4,
  });
  const addLamp = (x: number, z: number, h: number, intensity: number, dist: number) => {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, h, 8),
      new THREE.MeshStandardMaterial({ color: 0x444a52, roughness: 0.8 }),
    );
    pole.position.set(x, h / 2, z);
    g.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 0.9), headMat);
    head.position.set(x, h + 0.3, z);
    g.add(head);
    const light = new THREE.PointLight(0xffe8b8, intensity, dist, 1.3);
    light.position.set(x, h + 1.5, z);
    g.add(light);
  };
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
    addLamp(Math.cos(a) * 26, Math.sin(a) * 26, 12, 2.2, 130);
  }
  addLamp(-88, -12, 16, 1.8, 160); // VAB apron
  addLamp(-78, 66, 10, 1.2, 90); // tracking station

  return g;
}
