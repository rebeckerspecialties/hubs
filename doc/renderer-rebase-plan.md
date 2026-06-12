# Renderer rebase plan (three.js / A-Frame)

Phased plan to move off the opaque, long-lived three.js + A-Frame forks. Each phase
is a separate PR; later phases stack on earlier ones.

## Version coupling (why this is staged)

A-Frame and three.js are version-coupled, and the Hubs forks add cross-cutting
customizations, so the ceiling is set by the most fragile patch, not by raw API
churn:

- **three r147** added `Object3D.matrixWorldAutoUpdate` — the native mechanism that
  overlaps with the fork's custom matrix-update optimization.
- **three r152** is the hard wall: the color-management overhaul removes
  `outputEncoding` / `Texture.encoding` / `sRGBEncoding` / `LinearEncoding`
  (replaced by `outputColorSpace` / `colorSpace` / `SRGBColorSpace`, with
  `ColorManagement.enabled` defaulting to **true**). r150 still has the old API, so
  **r150 is the highest three you can take without the color-management migration.**
- **r155** flips `useLegacyLights` to physically-correct by default.
- A-Frame 1.4.x pairs with three ~r150; 1.5.x with ~r158; 1.6.x with ~r164.

## Phase A — three **r149**, matrix-opt preserved (this PR)

Goal: capture ~8 releases of upstream fixes (notably GLTFLoader hardening relevant
to the malformed-VRM crash) plus `matrixWorldAutoUpdate` (r147) at **near-zero
risk**, without touching the A-Frame fork.

**Why r149, not r150:** r150 is the "mass removal" release — it deletes the
`*BufferGeometry` aliases, `BasisTextureLoader`, and the old `Object3D` static
names, turning the bump into a ~30-file migration. **r149 keeps every one of those
deprecated aliases at runtime**, so it's the last clean stepping stone. The full
r150 removal migration (and the r152 color-management migration) is deferred to
Phase C.

**The @types pin (key to "no new tsc errors"):** we bump the three **runtime** to
0.149 but keep **`@types/three@^0.141.0`** (unchanged from master). tsc only sees
`@types/three`, so type-checking behaves exactly as it does today — no new errors,
no `as any` churn — while the runtime gains the fixes. r149's runtime still ships
all the deprecated aliases the 0.141 types describe (`PlaneBufferGeometry`,
`Scene.autoUpdate`, `renderer.physicallyCorrectLights`, `BasisTextureLoader`), so
the type/runtime skew is safe. Bumping `@types/three` to match the runtime is part
of the Phase C migration. (`checkJs` is off, so the ~25 `.js` files that use the
deprecated geometry names aren't type-checked anyway.)

- `three` 0.141.0 → **0.149.0** (registry, integrity-locked); `@types/three`
  **stays ^0.141.0**.
- `patches/three+0.141.0.patch` → **`patches/three+0.149.0.patch`**, rebased by
  3-way merge (base r141, ours = fork, theirs = r149). 20 hunks merged cleanly; 4
  conflicts resolved behavior-preserving:
  - `Object3D.js` (matrix-opt): took the fork side; also kept r149's new
    `matrixWorldAutoUpdate` field so the renderer sees it.
  - `WebGLRenderer.js` / `WebGLLights.js`: kept the reflection-probe additions
    alongside r149's renamed light sort + clipping global-state call.
  - `WebXRManager.js`: **dropped** — r149 upstreamed the fork's camera-matrix
    `decompose`, so that patch is now obsolete.
- The only genuine r149 runtime removal that affects us is `Object3D.DefaultUp` /
  `DefaultMatrixAutoUpdate` → `DEFAULT_UP` / `DEFAULT_MATRIX_AUTO_UPDATE`; updated
  the 3 (`.js`, untyped) call sites. The A-Frame fork does not use these.
- `webpack.config.js`: transcoder paths repointed to `examples/jsm/libs` (moved
  there by r149). `BasisTextureLoader` import stays stock (r149 still ships it).
- `.browserslistrc`: Safari/iOS floor raised to **17**; Chrome to **91** (WebXR
  baseline), XR device minimums inline. `.npmrc` / Dockerfile `--legacy-peer-deps`
  for the intentional three-ahead-of-A-Frame peer mismatch.
- A-Frame is left on `hubs/master` so the matrix-opt pairing (A-Frame sets
  `matrixNeedsUpdate`, three's patch consumes it) stays intact.

**Verification required (CI/runtime):** `npm run check` (tsc — expected green, since
`@types/three` is unchanged) and `npm run build` (the Docker build runs this), plus
a runtime smoke test on the target browsers and a VR/visionOS pass.
The patch was verified to apply to a clean `three@0.150.0` and reproduce the merged
sources exactly.

## Phase B — retire the matrix-opt (stacks on A)

Hypothesis (see security-analysis doc §1 discussion): modern three + JS engines no
longer need the fork's custom matrix system, and `matrixWorldAutoUpdate` covers the
static-scene case natively. This is the keystone removal — it also lets the A-Frame
fork shed its `matrixNeedsUpdate` plumbing, moving it toward stock.

- Gate on a benchmark: a scene with ~20-30 avatars + a heavy environment GLTF on
  stock r150, comparing frame time with vs. without the matrix-opt (set
  `o.matrixWorldAutoUpdate = false` on static roots).
- Mechanical migration of the call sites once the benchmark clears:
  - `grep -rE "matrixNeedsUpdate" src` → **68 files**: removable under stock
    auto-update (or replace with explicit `updateMatrix()` where needed).
  - `grep -rE "\.updateMatrices\(" src` → **43 files**: → `updateMatrixWorld()` /
    `updateWorldMatrix(true, false)`.
  - `grep -rE "\.near\(" src` (Vector3/Quaternion/Matrix4) → 3 files: → `.equals()`
    or explicit epsilon.
- Then drop the matrix-opt hunks from the three patch and the A-Frame
  `matrixNeedsUpdate`/`updateMatrices` customizations.

## Phase C — drop custom reflection probes + LUT tonemapping (next version jump)

Both are Hubs-only three patches with no upstream equivalent. Replace with
upstream-supported features at the jump past r152:

- **Reflection probes** (`src/inflators/reflection-probe.ts`,
  `src/bit-systems/scene-loading.ts`, `src/systems/environment-system.js`):
  reimplement on light probes / baked env maps (or a post-processing approach).
- **LUT tonemapping** (`src/systems/environment-system.js`, `src/effects.ts`):
  move to a post-processing LUT pass.
- Perform the **r152 color-management migration** here (the call-site inventory
  below), which is the precondition for r152+ and A-Frame 1.5+.

## Rework inventory (the "locations that need re-working")

Seam files are annotated inline with `// UPGRADE`. The mechanical call-site sets are
listed here rather than tagged in every file to avoid churn:

| Concern | Phase | How to find every site |
|---|---|---|
| Custom matrix API | B | `grep -rE "matrixNeedsUpdate\|\.updateMatrices\(\|\.near\(" src` |
| Color management | C / r152 | `grep -rE "sRGBEncoding\|LinearEncoding\|outputEncoding\|\.encoding\s*=" src` (17 files) |
| Reflection probes | C | `src/inflators/reflection-probe.ts`, `src/systems/environment-system.js`, `src/bit-systems/scene-loading.ts` |
| LUT tonemapping | C | `src/systems/environment-system.js`, `src/effects.ts` |
| Raycaster layers shim | later | three patch (`Raycaster.js`): refactor interaction code to use layers, then drop |
| Disabled WebGL2 morph path | B/C | three patch (`WebGLMorphtargets`/`WebGLProgram`): re-enable; relevant to high-blendshape VRM avatars |
| Inlined three-vrm code | VRM | `src/utils/three-utils.js` (`excludeTriangles`/`createErasedMesh`): adopt `three-vrm` |

## A-Frame — what r149 means for an A-Frame bump

Short version: **Phase A (r149) needs no A-Frame change, and r149 does not move us
any closer to a stock A-Frame.** Two things to keep separate:

1. **The Hubs A-Frame fork on r149.** The fork (`hubs/master`) was built for three
   r141 and runs unchanged on r149 — every API it relies on is still present
   (r150 is where the removals land). It does not use the renamed `Object3D`
   statics. So Phase A stays three-only; the `peer three@^0.141` mismatch is just a
   warning we silence with `legacy-peer-deps`. That's the point of r149: keep the
   fork as-is while the runtime moves forward.

2. **Adopting upstream A-Frame is gated *past* r149.** Upstream A-Frame 1.4.x is
   built for three **r150** (it uses `renderer.useLegacyLights`, an r150 API), and
   1.5.x for ~r158. So you cannot bump to a stock A-Frame while pinning three at
   r149 — doing so requires crossing the same r150 removal wall (the ~30-file
   geometry/lighting/color migration). **An A-Frame bump and the r150 migration are
   the same project**, which is why both live in Phase C, after Phase B removes the
   matrix-opt coupling (the largest reason the fork can't track upstream).

Sequencing, therefore:
- **Phase A (now):** three r149, A-Frame fork unchanged.
- **Phase B:** retire the matrix-opt — decouples the fork from the custom
  `Object3D`, the prerequisite for tracking upstream A-Frame.
- **Phase C:** cross r150 (the removal migration) + r152 (color management) and
  move A-Frame to upstream 1.4/1.5 (or forward-port the fork) **together**, since
  they're version-locked. `hubs/master-three-r147` is a useful reference (Hubs
  already advanced the fork to r147 there), but it targets upstream three, so it
  also assumes the matrix-opt is gone (Phase B).

The fork itself diverged from upstream at ~v0.9 (Feb 2019) and is a hard fork, not
a thin patch stack, so the Phase C A-Frame step is a forward-port/migration, not a
patch-package stack.
