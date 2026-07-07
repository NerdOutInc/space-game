import * as THREE from 'three';
import { Body } from '../universe/bodies';

/**
 * Soft atmosphere: for each fragment on an oversized shell, compute the view
 * ray's closest approach to the planet center (impact parameter b) and fade
 * the haze with exp(-(b - planetR)/scaleH). Full density over the disc,
 * exponential falloff above the surface, no hard geometric edge.
 * Includes log-depth chunks so it sorts correctly against the planet.
 */
export function makeAtmosphereMaterial(
  color: THREE.Color,
  planetR: number,
  shellR: number,
  scaleH: number,
  intensity = 0.7,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uPlanetR: { value: planetR },
      uShellR: { value: shellR },
      uScaleH: { value: scaleH },
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
      uniform float uPlanetR;
      uniform float uShellR;
      uniform float uScaleH;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        #include <logdepthbuf_fragment>
        float c = abs(dot(normalize(vNormal), normalize(vView)));
        // closest approach of this view ray to the planet center
        float b = uShellR * sqrt(max(1.0 - c * c, 0.0));
        float depth = exp(-max(b - uPlanetR, 0.0) / uScaleH);
        // subtle veil over the disc, full strength only near the limb
        float limb = smoothstep(uPlanetR * 0.55, uPlanetR, b);
        gl_FragColor = vec4(uColor, depth * uIntensity * mix(0.22, 1.0, limb));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/** Attach a soft atmosphere shell as a child of a planet mesh (flight view). */
export function addAtmosphereShell(planetMesh: THREE.Mesh, body: Body): void {
  if (!body.atmosphere) return;
  const a = body.atmosphere;
  const shellR = body.radius + a.height * 4;
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(shellR, 96, 48),
    makeAtmosphereMaterial(a.skyColor.clone(), body.radius, shellR, a.height * 1.3, 0.75),
  );
  planetMesh.add(shell);
}
