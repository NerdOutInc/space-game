import * as THREE from 'three';
import { Body } from '../universe/bodies';

/**
 * Fresnel rim-glow material: transparent at the disc center, glowing at the
 * limb — reads as an atmospheric halo from orbit. Includes the log-depth
 * chunks so it sorts correctly against the planet with the logarithmic
 * depth buffer enabled.
 */
export function makeAtmosphereMaterial(color: THREE.Color, intensity = 0.9): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uIntensity: { value: intensity },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        #include <logdepthbuf_fragment>
        float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.2);
        gl_FragColor = vec4(uColor, rim * uIntensity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/** Attach a rim-glow atmosphere shell as a child of a planet mesh (flight view). */
export function addAtmosphereShell(planetMesh: THREE.Mesh, body: Body): void {
  if (!body.atmosphere) return;
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(body.radius + body.atmosphere.height * 1.4, 96, 48),
    makeAtmosphereMaterial(body.atmosphere.skyColor.clone(), 0.85),
  );
  planetMesh.add(shell);
}
