import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';
import { VolumetricFogPass } from './VolumetricFogPass.js';

// ---------------------------------------------------------------------------
// High-quality WebGL2 renderer + cinematic post chain.
//
// Tone mapping: AgX (punchy filmic contrast for sunny outdoor scenes), with
// an ACES+contrast fallback kept behind a flag for easy A/B.
//
// Anti-double-tonemap contract:
//   The composer renders the SCENE in LINEAR HDR (renderer.toneMapping is
//   temporarily cleared during RenderPass), so UnrealBloom operates on true
//   HDR values. OutputPass at the end performs tone-map (AgX) + sRGB encode.
//   We never tonemap twice.
// ---------------------------------------------------------------------------

// Flip this to false to use the ACES + custom contrast fallback instead.
// AgX is deliberately desaturating/pastel — wrong for Forza Horizon's hyper-
// vibrant, punchy, golden-hour look. ACES keeps more chroma in the midtones and
// the saturation+split-tone finish pass below restores the vibrant arcade grade.
const USE_AGX = false;

// --- Film-grain + vignette finish pass (full-screen fragment shader) --------
// Subtle vignette (~0.2 stops in the corners) + ~2% animated film grain.
// Grain uses a hash of uv + a frame counter (no Date.now / Math.random so the
// sequence is deterministic and SSR-safe).
const CinematicFinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    // Frame counter, incremented in render() to animate the grain.
    uFrame: { value: 0.0 },
    // Vignette intensity. ~0.16 at the corner for a cinematic grade.
    uVignetteStrength: { value: 0.10 },
    uVignetteFalloff: { value: 0.50 }, // smooth radial falloff
    // Grain amount (mixed in linearly). 0.018 == ~1.8%.
    uGrainAmount: { value: 0.0 }, // grain caused shimmer/flicker — off
    // ── Vibrant golden-hour grade (display space) ───────────────────────────
    uSaturation: { value: 1.32 },   // >1 pushes chroma back (ACES mutes it)
    uContrast: { value: 1.10 },     // around a 0.5 pivot
    // Split-tone tints: cool teal shadows / warm orange highlights.
    uShadowTint:    { value: new THREE.Vector3(0.94, 1.015, 1.07) }, // cool
    uHighlightTint: { value: new THREE.Vector3(1.09, 1.00, 0.90) },  // warm
    uSpeedStretch: { value: 0.0 },
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
    uniform float uFrame;
    uniform float uVignetteStrength;
    uniform float uVignetteFalloff;
    uniform float uGrainAmount;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uSpeedStretch;

    varying vec2 vUv;

    // Cheap deterministic hash -> [0,1]. No randomness libraries needed.
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      float stretch = 0.0; // chromatic smear disabled — was a major flicker source
      vec2 uv = vUv;
      vec3 color = texture2D(tDiffuse, uv).rgb;

      // 1) Contrast around a 0.5 pivot (display space) — punchier midtones.
      color = clamp((color - 0.5) * uContrast + 0.5, 0.0, 1.0);

      // 2) Saturation: push chroma back (ACES/AgX both desaturate).
      float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(l), color, uSaturation);

      // 3) Split-tone: cool teal shadows, warm orange highlights (by luma).
      float t = smoothstep(0.0, 1.0, l);
      color *= mix(uShadowTint, uHighlightTint, t);

      // 4) Vignette: smooth radial darkening centered on screen.
      vec2 d = vUv - 0.5;
      float dist = sqrt(dot(d, d)) * 1.41421356; // ~sqrt(2) -> corner==1
      float vig = smoothstep(uVignetteFalloff, 1.0, dist);
      color *= 1.0 - vig * uVignetteStrength;

      // 5) Film grain OFF (animated grain shimmered badly in browser).
      // float noise = hash21(vUv * vec2(1920.0, 1080.0) + uFrame);
      // color += (noise - 0.5) * 2.0 * uGrainAmount;

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

// --- Optional contrast pass (only used when NOT on AgX) ---------------------
// Re-seats the black point and adds punch to an otherwise milky ACES frame:
//   color = pow(max(color,0), 0.88); color = color*1.06 - 0.03;
const ContrastShader = {
  uniforms: {
    tDiffuse: { value: null },
    uGamma: { value: 0.88 },   // mid-tone lift via power curve
    uGain: { value: 1.06 },    // overall brightness gain
    uOffset: { value: -0.03 }, // re-seat black point (kills the milky lift)
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
    uniform float uGamma;
    uniform float uGain;
    uniform float uOffset;
    varying vec2 vUv;
    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      color = pow(max(color, 0.0), vec3(uGamma));
      color = color * uGain + uOffset;
      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    // Pixel ratio: capped at 1.25 (not devicePixelRatio/1.75). On a DPR=2 Retina
    // panel the old 1.75 cap rendered at ~3360x1890 (~6.3M fragments) per full-
    // screen post pass; 1.25 gives ~2400x1335 (~3.2M) — roughly half the fragment
    // work — while SMAA in the post chain keeps edges crisp, so the visual grade
    // is preserved. This was the single biggest measured lever after removing
    // forest shadow casting.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // AgX gives punchier filmic contrast for bright outdoor/sunny scenes.
    // (When USE_AGX is false, ACES is used and a contrast pass re-seats
    // the black point — see _buildComposer.)
    this.renderer.toneMapping = USE_AGX ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
    // AgX is slightly darker than ACES; nudge exposure up to compensate.
    // ACES fallback also gets a mild exposure bump for the punchier look.
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc4e8);

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.4, 8000);

    // Per-frame counter driving the animated film grain (no Date.now/random).
    this._frame = 0;
    this._qualityTier = 'mid';

    this._buildComposer();
    window.addEventListener('resize', () => this.onResize());
  }

  _buildComposer() {
    const { renderer, scene, camera } = this;
    this.composer = new EffectComposer(renderer);

    // Depth buffer for volumetric fog aerial perspective.
    const bufSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      rt.depthBuffer = true;
      rt.depthTexture = new THREE.DepthTexture(bufSize.x, bufSize.y);
    }

    // 1) Scene pass.
    //    highlights. Tone mapping (AgX/ACES) is applied later by OutputPass,
    //    which reads renderer.toneMapping — so we must NOT let RenderPass
    //    also tonemap. render() swaps toneMapping around this pass.
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Screen-space reflections on paint, glass, and wet asphalt.
    this.ssr = new SSRPass({
      renderer,
      scene,
      camera,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    this.ssr.maxDistance = 24;
    this.ssr.opacity = 0.38;
    this.ssr.thickness = 0.018;
    this.ssr.enabled = false; // SSR is costly and flickers on many GPUs — off by default
    this.composer.addPass(this.ssr);

    // Screen-space ambient occlusion — grounds contact shadows on terrain/props.
    this.ssao = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
    this.ssao.kernelRadius = 6;
    this.ssao.minDistance = 0.003;
    this.ssao.maxDistance = 0.05;
    this.ssao.enabled = false; // off by default for stable 60fps in browser
    this.composer.addPass(this.ssao);

    // Optional contrast pass — only wired in for the ACES fallback path so
    // the milky/lifted-black look gets re-seated. Runs in linear space
    // before bloom so the contrast curve affects HDR values consistently.
    this.contrastPass = null;
    if (!USE_AGX) {
      this.contrastPass = new ShaderPass(ContrastShader);
      this.composer.addPass(this.contrastPass);
    }

    // Volumetric-style atmospheric fog: sun-directional in-scatter haze on the
    // horizon. Runs in linear HDR after the scene/contrast passes, before bloom
    // so the warm scatter participates in the bloom kernel.
    this.volumetricFog = new VolumetricFogPass();
    this.volumetricFog.setDepthTexture(this.composer.readBuffer.depthTexture);
    this.volumetricFog.pass.enabled = false; // depth fog shimmered — keep off for stability
    this.composer.addPass(this.volumetricFog.pass);

    // 2) Dual-bloom approximation: slightly stronger core + tighter threshold so
    //    sun disk, paint specular and bright sky catch without washing midtones.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.28, // strength — was 0.32; combined with the lens-glow + hot sun disk
            // it white-clipped everything facing the sun
      0.5,
      0.82, // higher threshold keeps midtones (road, paint) out of the kernel
    );
    this.composer.addPass(this.bloom);

    // 3) SMAA anti-aliasing (kept after bloom so edges stay crisp).
    this.smaa = new SMAAPass(window.innerWidth, window.innerHeight);
    this.composer.addPass(this.smaa);

    // 4) OutputPass: performs tone mapping (AgX/ACES, read from
    //    renderer.toneMapping) + sRGB transfer. This is the ONLY place
    //    tonemapping happens, preventing double tonemapping.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // 5) Cinematic finish: subtle vignette (~0.2 stops) + ~2% animated
    //    film grain. Runs LAST, on the already-tonemapped sRGB display buffer,
    //    so vignette darkening and grain behave perceptually (a stops-based
    //    multiply + display-space noise) instead of being re-tonemapped.
    this.finishPass = new ShaderPass(CinematicFinishShader);
    this.finishPass.renderToScreen = true;
    this.composer.addPass(this.finishPass);
  }

  // --- Small setters for live tuning ----------------------------------------
  setBloom(strength) { if (this.bloom) this.bloom.strength = strength; }

  /** Optional quality tiers — only call on a slow timer, not every frame. */
  setAdaptiveQuality(fps) {
    if (this._qualityTier === 'low' && fps > 55) this._qualityTier = 'mid';
    else if (this._qualityTier === 'mid' && fps < 38) this._qualityTier = 'low';
    else if (this._qualityTier === 'mid' && fps > 58) this._qualityTier = 'high';
    else if (this._qualityTier === 'high' && fps < 45) this._qualityTier = 'mid';
    const tier = this._qualityTier ?? 'mid';
    // Bloom is art-directed (see constructor) — the quality tiers must NOT
    // override it upward. Previously this reset strength to 0.48–0.55 every
    // 0.5s, undoing the tuned value and re-creating the sun-side blowout.
    // Tiers now only modulate it slightly downward when the GPU struggles.
    if (this.bloom) this.bloom.strength = tier === 'low' ? 0.22 : 0.28;
  }
  setExposure(v) { this.renderer.toneMappingExposure = v; }
  setVignette(strength) { if (this.finishPass) this.finishPass.uniforms.uVignetteStrength.value = strength; }
  setGrain(amount) { if (this.finishPass) this.finishPass.uniforms.uGrainAmount.value = amount; }
  setSaturation(v) { if (this.finishPass) this.finishPass.uniforms.uSaturation.value = v; }
  setContrast(v) { if (this.finishPass) this.finishPass.uniforms.uContrast.value = v; }
  setSpeedStretch(v) {
    if (this.finishPass) this.finishPass.uniforms.uSpeedStretch.value = v;
  }

  setSunDir(dir) {
    if (this.volumetricFog) this.volumetricFog.setSunDir(dir);
  }

  setFogColor(color) {
    if (this.volumetricFog) this.volumetricFog.setFogColor(color);
  }

  setFogDensity(density) {
    if (this.volumetricFog) this.volumetricFog.setFogDensity(density);
  }

  setSunColor(color) {
    if (this.volumetricFog) this.volumetricFog.setSunColor(color);
  }

  setSunIntensity(intensity) {
    if (this.volumetricFog) this.volumetricFog.setSunIntensity(intensity);
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    if (this.ssao) this.ssao.setSize(w, h);
    if (this.ssr) this.ssr.setSize(w, h);
    // Reallocate depth textures on resize.
    const bufSize = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      rt.depthTexture = new THREE.DepthTexture(bufSize.x, bufSize.y);
    }
    if (this.volumetricFog) {
      this.volumetricFog.setDepthTexture(this.composer.readBuffer.depthTexture);
    }
  }

  render() {
    // Render the scene in LINEAR HDR so bloom + finish operate on true HDR
    // values, then let OutputPass do the single tonemap + sRGB encode.
    // Swapping toneMapping here (rather than leaving it on the renderer)
    // is what prevents double tonemapping: RenderPass sees NoToneMapping,
    // OutputPass reads the restored AgX/ACES.
    const savedToneMapping = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;

    if (this.volumetricFog) this.volumetricFog.updateCamera(this.camera);

    this.composer.render();

    this.renderer.toneMapping = savedToneMapping;

    // Advance the frame counter to animate the film grain.
    this._frame += 1;
    if (this.finishPass) {
      this.finishPass.uniforms.uFrame.value = this._frame;
    }
  }
}
