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
      // sunlight direction in VIEW space — update per frame via
      // updateAtmosphereSun(); defaults to "toward camera" (fully lit)
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
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
      uniform vec3 uSunDir;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vNormal);
        float c = abs(dot(n, normalize(vView)));
        // closest approach of this view ray to the planet center
        float b = uShellR * sqrt(max(1.0 - c * c, 0.0));
        float depth = exp(-max(b - uPlanetR, 0.0) / uScaleH);
        // subtle veil over the disc, full strength only near the limb
        float limb = smoothstep(uPlanetR * 0.55, uPlanetR, b);
        // atmospheres scatter SUNLIGHT: dark past the terminator, with a
        // soft twilight band
        float sun = clamp(dot(n, uSunDir) * 1.5 + 0.35, 0.02, 1.0);
        gl_FragColor = vec4(uColor, depth * uIntensity * mix(0.22, 1.0, limb) * sun);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

const _sunView = new THREE.Vector3();

/**
 * Point an atmosphere material's sunlight at the star. `sunDirWorld` is the
 * direction FROM the planet TOWARD the sun; it's converted into the given
 * camera's view space (call after the camera matrices are up to date).
 */
export function updateAtmosphereSun(
  mat: THREE.ShaderMaterial,
  sunDirWorld: THREE.Vector3,
  camera: THREE.Camera,
): void {
  _sunView.copy(sunDirWorld).transformDirection(camera.matrixWorldInverse);
  (mat.uniforms.uSunDir.value as THREE.Vector3).copy(_sunView);
}

/**
 * Attach a soft atmosphere shell as a child of a planet mesh (flight view).
 * Returns the material so the scene can keep its sunlight direction fresh.
 */
export function addAtmosphereShell(
  planetMesh: THREE.Mesh,
  body: Body,
): THREE.ShaderMaterial | null {
  if (!body.atmosphere) return null;
  const a = body.atmosphere;
  const shellR = body.radius + a.height * 4;
  const mat = makeAtmosphereMaterial(
    a.skyColor.clone(),
    body.radius,
    shellR,
    a.height * 1.3,
    0.75,
  );
  const shell = new THREE.Mesh(new THREE.SphereGeometry(shellR, 96, 48), mat);
  planetMesh.add(shell);
  return mat;
}
