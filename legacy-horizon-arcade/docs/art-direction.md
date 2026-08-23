# Art Direction — Horizon Festival Mexico

Single source of truth for ALL layers. Every module must conform or be scrapped.
Reference: Forza Horizon 5 (Mexico) — golden-hour warmth, saturated but natural color,
crisp specular highlights, soft atmospheric depth.

## Palette (sRGB values, hex)

| Role | Hex | Notes |
|------|-----|-------|
| Sun core | `fff4e0` | near-white warm |
| Sun halo | `ffd9a0` | warm amber falloff |
| Zenith sky | `3a7bd5` | deep blue, never purple |
| Horizon haze | `e8b88a` | dusty orange band at horizon |
| Grass base | `5a8f3c` | dry Mexican scrub green |
| Grass highlight | `8fb85a` | sunlit tips |
| Dirt | `9b7654` | terracotta dirt roads/off-track |
| Rock | `8a8078` | warm gray, never blue-gray cold |
| Road asphalt | `3a3d42` | dark neutral, slight warm cast |
| Marking white | `f0e8d8` | aged white paint, never pure `ffffff` |
| Marking yellow | `e8c040` | center-line yellow |
| Curb red/white alt | `d04838` / `f0e8d8` | FH-style curbs |

## Lighting

- Key light: warm directional sun, intensity ~2.2, color `ffe8cc`
- Ambient/hemisphere: sky `7ba7d5` top, ground `8a6a45` bottom, intensity 0.55
- ACES Filmic tone mapping, exposure ~1.1
- Shadows: PCFSoft, 2048 map minimum, bias -0.0005
- Fog: exp² falloff toward horizon, color `e8b88a`, density tuned so mountains
  fade at ~2km

## Materials rules

- Roughness: asphalt 0.85, grass 0.95, rock 0.8, car paint clearcoat 0.15 roughness
- Metalness: cars 0.85 body, 0.15 trim; road furniture 0.6 galvanized steel
- Everything reads slightly warm — no pure black (`000`), no pure white (`fff`)
- Car paint: MeshPhysicalMaterial, clearcoat 1.0, clearcoatRoughness 0.12

## Post-processing stack (in order)

1. RenderPass → SMAA (not FXAA)
2. SSAO subtle (intensity 0.35, radius 0.5) — contact shadows under cars/trees
3. Bloom threshold 0.85, strength 0.35, radius 0.5 — sun glints, festival LEDs
4. Volumetric fog pass (exp² height fog toward horizon)
5. Color grade: warm LUT, lift shadows +0.03, saturate +1.08, tint highlights `ffd9a0`

## What "AAA" means here (kill-list for critics)

- No flat untextured green terrain — splat-mapped grass/dirt/rock blend
- No glowing white line "markings" — painted markings with worn edges, slight
  retro reflectivity
- No low-poly cone mountains — layered ridges with haze depth cueing
- No red-blob car — GLTF hero model with clearcoat paint, visible wheel detail
- Trees: billboards far away, instanced meshes near road
- Water: animated normal detail, sun glint specular, fresnel reflections
- Festival hub: stage, LED screen, flags, balloons, tire barrier stacks
