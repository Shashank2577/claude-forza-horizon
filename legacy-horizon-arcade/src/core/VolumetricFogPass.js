import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ---------------------------------------------------------------------------
// Screen-space volumetric fog — depth-integrated aerial perspective + sun
// in-scatter. Uses the composer depth buffer when available; falls back to
// horizon-only haze when tDepth is null.
// ---------------------------------------------------------------------------

const VolumetricFogShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uFogColor: { value: new THREE.Color('#eccfa3') },
    uFogDensity: { value: 0.22 },
    uSunColor: { value: new THREE.Color('#ff9b3d') },
    uSunIntensity: { value: 1.35 },
    uCameraNear: { value: 0.4 },
    uCameraFar: { value: 8000 },
    uInverseProjectionMatrix: { value: new THREE.Matrix4() },
    uInverseViewMatrix: { value: new THREE.Matrix4() },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec3 uSunDir;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    uniform vec3 uSunColor;
    uniform float uSunIntensity;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform mat4 uInverseProjectionMatrix;
    uniform mat4 uInverseViewMatrix;

    varying vec2 vUv;

    vec3 worldViewDir(vec2 uv) {
      vec4 clip = vec4(uv * 2.0 - 1.0, 1.0, 1.0);
      #ifdef GL_FRAGMENT_PRECISION_HIGH
        clip.y = -clip.y;
      #endif
      vec4 view = uInverseProjectionMatrix * clip;
      view /= view.w;
      return normalize((uInverseViewMatrix * vec4(view.xyz, 0.0)).xyz);
    }

    float linearDepth(vec2 uv) {
      float depthSample = texture2D(tDepth, uv).x;
      if (depthSample >= 1.0) return uCameraFar;
      return uCameraNear * uCameraFar / (uCameraFar - depthSample * (uCameraFar - uCameraNear));
    }

    void main() {
      vec3 scene = texture2D(tDiffuse, vUv).rgb;
      vec3 viewDir = worldViewDir(vUv);
      vec3 sun = normalize(uSunDir);

      float horizon = 1.0 - smoothstep(-0.02, 0.28, viewDir.y);

      vec2 viewH = normalize(viewDir.xz + vec2(1e-5));
      vec2 sunH = normalize(sun.xz + vec2(1e-5));
      float horizDot = dot(viewH, sunH);
      float sunAzimuth = pow(max(horizDot * 0.5 + 0.5, 0.0), 1.8);

      float cosAng = max(dot(viewDir, sun), 0.0);
      float mie = pow(cosAng, 5.5);
      float mieWide = pow(cosAng * 0.5 + 0.5, 3.0);

      float linearD = linearDepth(vUv);
      float distFog = 1.0 - exp(-linearD * 0.00022);

      float fogAmt = mix(horizon * uFogDensity, distFog, 0.5);
      fogAmt *= 0.45 + 0.55 * sunAzimuth;

      float luma = dot(scene, vec3(0.2126, 0.7152, 0.0722));
      float skyMask = smoothstep(0.55, 0.92, luma);
      fogAmt *= 1.0 - skyMask * 0.25;

      vec3 scatter = mix(uFogColor, uSunColor, mieWide * uSunIntensity * 0.55);
      scatter += uSunColor * mie * uSunIntensity * 0.25;

      vec3 color = mix(scene, scatter, clamp(fogAmt, 0.0, 0.85));

      float horizonGlow = horizon * sunAzimuth * (mie * 0.7 + mieWide * 0.3);
      horizonGlow *= uSunIntensity * 0.16;
      color += uSunColor * horizonGlow;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export class VolumetricFogPass {
  constructor() {
    this.pass = new ShaderPass(VolumetricFogShader);
    this.uniforms = this.pass.uniforms;
  }

  setSunDir(dir) {
    this.uniforms.uSunDir.value.copy(dir);
  }

  setFogColor(color) {
    this.uniforms.uFogColor.value.set(color);
  }

  setFogDensity(density) {
    this.uniforms.uFogDensity.value = density;
  }

  setSunColor(color) {
    this.uniforms.uSunColor.value.set(color);
  }

  setSunIntensity(intensity) {
    this.uniforms.uSunIntensity.value = intensity;
  }

  setDepthTexture(tex) {
    this.uniforms.tDepth.value = tex;
  }

  setCameraParams(near, far) {
    this.uniforms.uCameraNear.value = near;
    this.uniforms.uCameraFar.value = far;
  }

  updateCamera(camera) {
    camera.updateMatrixWorld();
    this.uniforms.uInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
    this.uniforms.uInverseViewMatrix.value.copy(camera.matrixWorld);
    this.setCameraParams(camera.near, camera.far);
  }
}
