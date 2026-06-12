# Hubs client security hardening analysis — June 2026

Scope: the `hubs` **client** in this repository. Reticulum (the Elixir backend)
is a separate repo and is referenced where server-side enforcement is the
authoritative control. This document records (a) the investigation of the custom
three.js / aframe forks, (b) the abuse vectors behind "people take over rooms and
post as admins where they aren't owners", (c) the concrete code changes made in
this branch, and (d) the recommended next wave of package updates.

> **Rebased on current upstream master (`b3f6c0a`, June 2026).** Master had
> already landed several modernizations this analysis first recommended:
> `pdfjs-dist` is on **v5** (CVE-2024-4367 resolved), the RetPageOrigin Docker
> image is on **Node 22**, webpack targets **es2020** with a modern
> `.browserslistrc`, and the dependency bumps (dashjs 4, hls.js, FortAwesome 7,
> core-js) and lint debt are done. What remains novel in this PR: the three.js
> fork → upstream + patch-package migration and the bitECS ownership-takeover fix.
> Re-run `npm audit` against current master for an up-to-date package picture —
> the table in §6 predates master's dependency bump.

---

## TL;DR

1. **The custom three.js fork is fully transparent — your fear of "changes in the
   build that aren't in the source" is disproven.** A fresh build from the fork's
   own `src/` is byte-for-byte identical to the committed `build/three.module.js`,
   and `examples/jsm` (including `GLTFLoader`) is byte-identical to stock three.js
   r141. The fork = upstream r141 + a 25-file source patch (reflection probes, an
   `Object3D` matrix-update optimization, LUT tonemapping, range-request
   `FileLoader`, and a few WebGL workarounds). **None of it touches GLTF/VRM
   parsing.**

2. **That patch stack is now expressed as an auditable `patch-package` patch**
   (`patches/three+0.141.0.patch`) applied to upstream `three@0.141.0`. Verified:
   `three@0.141.0` (npm) + the patch reproduces the fork's `src/` exactly. This
   removes the opaque prebuilt dependency and unblocks future three.js upgrades.

3. **The "malformed asset → takeover" theory is not explained by the three.js
   fork.** The real asset-driven code-execution risk is **`pdfjs-dist@^2.14.305`,
   which is vulnerable to CVE-2024-4367 (arbitrary JavaScript execution from a
   malicious PDF)** — directly reachable by any participant who can share a PDF.

4. **The "post as admin / take over objects in rooms you don't own" abuse maps to
   a client-trust gap in the newer bitECS networking path.** Incoming entity
   *update* messages were applied after only an ordering check, with no permission
   check — unlike the legacy NAF path. Any peer could broadcast an ownership
   takeover. This is fixed and unit-tested in this branch (defense-in-depth);
   **authoritative enforcement must also exist in Reticulum.**

5. **The aframe fork — not three.js — is the real upgrade blocker.** It is a
   long-lived hard fork that diverged from upstream in **February 2019** (around
   aframe v0.9) and was independently maintained, with three manually advanced to
   r141. It cannot be reduced to a thin patch-package stack; upgrading it is a
   migration project. Importantly, **moving three.js does not require moving
   aframe** (webpack forces a single shared three instance regardless).

---

## 1. three.js fork — findings and the patch-package migration

### 1.1 What it was

`package.json` pinned:

```
"three": "github:hubs-foundation/three.js#65b5105908f5f135cad25fed07e25f15f3876777"
```

- The fork's `package.json` is version `0.141.0` and points `main`/`module` at a
  **committed prebuilt bundle** (`build/three.js`, `build/three.module.js`, …).
- `webpack.config.js` aliased `three$` → `node_modules/three/build/three.module.js`,
  so the app shipped the prebuilt bundle and `src/` was *not* what got bundled.
  This is exactly the "shipping an opaque binary" situation that motivated the fear.

### 1.2 Transparency proof (why the fork is safe to replace)

| Check | Result |
|---|---|
| Rebuild `build/three.module.js` from the fork's own `src/` (rollup) | **Byte-identical** to the committed bundle (1,158,698 bytes; 0 diff after whitespace normalization) |
| `examples/jsm` (471 files, incl. `GLTFLoader.js`) fork vs upstream r141 | **Byte-identical** |
| `three@0.141.0` (npm) + `patches/three+0.141.0.patch` vs fork `src/` | **Byte-identical** |

Conclusion: there are no hidden changes. The shipped bundle is fully reproducible
from auditable source, and the GLTF/VRM loaders are stock r141.

### 1.3 What the fork actually changes (the 25-file stack)

- **Reflection probes** (a Hubs rendering feature): new `lights/ReflectionProbe.js`;
  `WebGLRenderer.js` (env-map selection/blending, +107 lines), `WebGLLights.js`,
  `WebGLMaterials.js`, `ShaderLib.js`, `WebGLCubeRenderTarget.js`, and the
  `envmap_common_pars` / `envmap_physical_pars` / `lights_fragment_maps` shader
  chunks; `Object3D.reflectionProbeMode`; export in `Three.js`.
- **`Object3D` matrix-update optimization**: a rewrite of `updateMatrixWorld` /
  `updateWorldMatrix` into `updateMatrices()` with dirty flags
  (`matrixNeedsUpdate`, `matrixIsModified`, `childrenNeedMatrixWorldUpdate`,
  `hasHadFirstMatrixUpdate`) plus `Matrix4.near()`, `Quaternion.near()`,
  `Vector3.near()` and a `PropertyBinding` tweak. This is performance-sensitive,
  stateful code — the riskiest part of the fork to carry forward, and worth
  prioritising in any three.js upgrade.
- **LUT tone mapping** (Blender-matching exposure): `constants.js`
  (`LUTToneMapping`), `tonemapping_pars_fragment.glsl.js`, `WebGLProgram.js`,
  `WebGLRenderer.js` (`tonemappingLUT` uniform).
- **Range-request `FileLoader`**: HTTP 206 handling, range-aware cache keys, and
  an `HttpError` type (used for byte-range media streaming).
- **WebGL platform workarounds**: `WebGLState.js` avoids `Function.prototype.apply`
  on `texImage2D/3D` / `compressedTexImage2D` (broken on some devices);
  `WebGLMorphtargets.js` + `WebGLProgram.js` disable the WebGL2 morph-target
  texture path ("causing issues on some systems"); `WebXRManager.js` decomposes
  the XR camera matrix; `PMREMGenerator.js` fixes a ping-pong target sizing check.
- **`PositionalAudio.js`**: skips PannerNode updates when position/orientation are
  unchanged (performance).
- **`Raycaster.js`** — *behavior change worth a security/UX review*: raycasting now
  `return`s early for invisible objects and **no longer tests `object.layers`**
  before calling `raycast`. If any interaction code relies on layers to keep
  objects non-interactive, this changes that assumption.

### 1.4 What changed in this branch

- `package.json`: `three` → `"0.141.0"`; added `patch-package` +
  `postinstall-postinstall` devDeps and a `"postinstall": "patch-package"` script.
- `patches/three+0.141.0.patch`: the extracted, verified 25-file stack.
- `webpack.config.js`: `three$` now resolves to `node_modules/three/src/Three.js`
  so the patched **source** is what webpack bundles (the single-instance invariant
  `AFRAME.THREE.Object3D === THREE.Object3D` is preserved because the alias still
  collapses every bare `three` import to one module).

**Required before merge:** run `npm install` (regenerates `package-lock.json` with
an integrity-pinned `three@0.141.0` and applies the patch) and `npm run build`,
then smoke-test a scene with reflection probes, range-request media, and VR. The
source-level equivalence is proven; the only thing not exercised in this analysis
is the webpack bundling-from-source step.

### 1.5 Upgrading three.js after this

Each upgrade becomes: bump `three`, run `npx patch-package three` against a
re-applied stack, resolve the handful of conflicting hunks (mostly the
`Object3D`/renderer changes), and re-verify. This is tractable in a way the
opaque fork never was. Strongly consider upstreaming or retiring the parts that
have upstream equivalents now (reflection probes, tone-mapping LUT) to shrink the
stack.

---

## 2. aframe fork — the real upgrade blocker

`"aframe": "github:hubs-foundation/aframe#hubs/master"`.

- Merge-base with upstream is `v0.9.1~120` (commit `cdb957f`, **2019-02-26**); the
  same commit is the merge-base for upstream v1.2.0/v1.3.0/v1.4.0, i.e. the fork
  diverged once around aframe v0.9 and never re-merged.
- Hubs' own delta since that point is **+499 / −12,053 across 120 `src/` files** —
  mostly *removing* unused aframe subsystems, plus a manual bump of three to r141.

Implication: this is a **hard fork**, not a patch set. Expressing it as
`patch-package` patches on a *current* upstream aframe is not feasible, because the
diff would also contain ~6 years of upstream changes the fork never took.
Upgrading aframe is a forward-port/migration effort (or a project to reduce the
client's dependence on the aframe layer in favour of the bitECS systems that are
already replacing it). It should be planned as such — but it is **decoupled from
the three.js cleanup above**, which can ship independently.

---

## 3. Privilege escalation — "take over / act as owner where you aren't one"

### 3.1 How authorization is modeled

- On join, Reticulum issues a `perms_token` (JWT). The client **decodes it without
  verifying the signature** (`hub-channel.js`: `// Note: token is not verified.`).
  That is acceptable *only if* the server independently authorizes every
  privileged operation — the client copy is a UI hint, not a control.
- `HubChannel.can(permission)` checks the local token; `userCan(clientId, perm)`
  checks another participant's permissions from Phoenix presence state.

### 3.2 The gap (fixed here): bitECS ownership takeover

There are two networking stacks. The legacy NAF path validates every incoming
manipulation in `src/utils/permissions-utils.js`
(`authorizeOrSanitizeMessage` → `authorizeEntityManipulation`): a sender can only
move/mutate/remove an entity if they created it or hold the relevant permission,
and pinned objects additionally require `pin_objects`.

The newer bitECS path did **not** do this. In
`src/bit-systems/network-receive-system.ts`, the create path checks
`hasPermissionToSpawn(...)`, but the **update** path applied incoming messages
after only `isOutdatedMessage(...)` (a timestamp/tiebreak ordering check). An
update message carries an attacker-chosen `owner` and `lastOwnerTime`, so any peer
could broadcast an update that claims ownership of any networked object and mutate
it; every receiving client would accept it.

**Fix in this branch:**

- `src/utils/authorize-entity-manipulation.js` — a dependency-free authorization
  core (reticulum-always-allowed; creator-or-required-permission; pinned ⇒ also
  `pin_objects`). Kept dependency-free specifically so it is unit-testable in
  isolation.
- `src/utils/permissions.ts` — `canManipulateNetworkedEntity(world, sender, eid)`
  looks up the entity's prefab (`createMessageDatas`), its pinned state, and
  creator, then defers to the core using `HubChannel.userCan`.
- `src/bit-systems/network-receive-system.ts` — the update loop now drops updates
  from senders that fail `canManipulateNetworkedEntity`, using the
  **server-attributed** `message.fromClientId` (set in
  `listen-for-network-messages.ts`), mirroring the existing create-path pattern.
- `test/unit/utils/authorize-entity-manipulation.test.js` — 8 cases covering the
  takeover vector, creator/permission/pinned combinations, and prefab-specific
  permissions. **All passing.**

**Threat-model note:** because each client evaluates this independently against
the server-attributed sender id, a maliciously modified peer can no longer make
*honest* clients accept a takeover. That is real mitigation even without server
changes — but it is **defense-in-depth, not the authoritative control.**

**Residual (documented) client-side limits:** updates that arrive before their
create message now carry the attributed sender through the stored-update queue, so
the guard runs when they are replayed (closing the race where a peer sends a
takeover update ahead of the create). Entities not instantiated through the bitECS
path (no `createMessageData`) are still not blocked here and are covered by
server-side enforcement.

### 3.3 What Reticulum must enforce (authoritative)

The client is not a trust boundary. Reticulum must, on its own:

- Sign the `perms_token` and reject forged/edited tokens.
- Authorize **every** privileged channel op server-side: `kick`/`mute`/`block`,
  `pin`/`unpin`, `update_hub`/`close_hub`/`update_roles`, `amplify_audio`,
  entity-state save/update/delete.
- Validate networked ownership/manipulation at the relay: do not rebroadcast an
  update/ownership claim the sender lacks permission for.
- Never trust a client-supplied chat `type` or `from` (see §4).

---

## 4. "Admin chats" — the chat receive path

Incoming chat is handled in `hub.js` (`hubPhxChannel.on("message", …)`): the
client renders whatever `type`/`from` the server delivers. This is
server-authoritative, so the protection lives in Reticulum: it must set `type`
(e.g. broadcast/admin styling) and `from` strictly from the authenticated
sender's permissions, and must never echo a client-chosen `type`/`from`. The
Discord bridge `from` field is a related spoofing surface to confirm is
server-stamped. No client change is required, but this should be explicitly
verified and pinned with a server-side test.

---

## 5. Asset-loading hardening (malformed GLTF / VRM / PDF / image)

The custom three.js is *not* the asset risk (GLTFLoader is stock r141). The risks
live in stock dependencies and in Hubs' own GLTF handling:

- **PDF — highest priority.** `pdfjs-dist@^2.14.305` is vulnerable to
  **CVE-2024-4367 (GHSA-wgrm-67xf-hhpq): arbitrary JS execution from a malicious
  PDF.** Any participant who can share a PDF can run script in other clients.
  Upgrade pdf.js (fixed in 4.2.67+) and/or set `isEvalSupported: false`. See §6.
- **GLTF component inflation** (`src/components/gltf-model-plus.js`,
  `src/gltf-component-mappings.js`): component data from `MOZ_hubs_components` is
  passed to inflators without JSON-schema validation; GLTF `node.name` is used as a
  DOM/CSS class after only `replace(/[^\w-]/g, "")`; the Sketchfab ZIP worker
  (`src/workers/sketchfab-zip.worker.js`) parses and rewrites GLTF JSON with no
  validation. Recommend: validate component data with the existing `jsonschema`
  dependency, tighten `node.name` handling, and add size/count limits.
- **URL sanitization**: `@braintree/sanitize-url` guards `javascript:` URLs for
  GLTF `media.src`/`link.href`, but not all sinks (e.g. node names). Keep it
  current (7.x) since this is the XSS guard for asset-supplied URLs.
- **Decoder DoS**: `createImageBitmap` / PDF / ZIP decoding on untrusted bytes has
  no size limits; consider bounds to reduce memory-exhaustion griefing.

Recommend adding unit tests for the node-name sanitizer and the component-data
validator alongside the existing `component-mappings.test.js`.

---

## 6. Next wave of package updates (evidence-based)

From `npm audit` against the current lockfile: **112 advisories total (21 critical,
43 high)**, of which **30 are in production dependencies (2 critical, 18 high)**.
Most of the criticals are in build/dev tooling, but the production set is what
participants and assets can reach. Prioritised:

### Runtime (do first — reachable by participants/assets)

| Package | Current | Advisory | Action |
|---|---|---|---|
| `pdfjs-dist` | ^2.14.305 | CVE-2024-4367 — arbitrary JS execution from malicious PDF (GHSA-wgrm-67xf-hhpq) | **Upgrade to ≥4.2.67** (breaking; or set `isEvalSupported:false` as interim) |
| `lodash-es` (transitive) | <4.17.21-ish | Prototype pollution + `_.template` code injection (GHSA-r5fr-rjxr-66jc, -f23m-r3pf-42rh) | Force-resolve to patched lodash |
| `semver` | ^7.3.2 | ReDoS CVE-2022-25883 (GHSA-c2qf-rxjj-qqgw) | Bump to ≥7.5.2 |
| `path-to-regexp` (via `react-router`) | 0.2–1.8 | ReDoS (GHSA-9wv6-86v2-598j) | Upgrade react-router or override |
| `request` / `request-promise` (dev/scripts) | deprecated | pulls vulnerable `qs`, `tough-cookie` | **Remove**; replace with `node-fetch`/`undici` (already present) |
| `@braintree/sanitize-url` | ^6.0.0 | asset-URL XSS guard | Move to 7.x and keep current |

### Build / dev tooling (still worth fixing; lower exposure)

`webpack` (DOM-clobbering XSS / buildHttp SSRF), `webpack-dev-middleware`
(path traversal, high), `ws` (DoS / memory disclosure, high),
`serialize-javascript` (XSS/RCE via terser-webpack-plugin), `word-wrap` /
`yaml` / `uuid` (ReDoS / stack overflow / bounds). Address via `npm audit fix`
where non-breaking; schedule the breaking ones.

### Process recommendations

- Add a CI step that runs `npm audit --omit=dev` and fails on high/critical
  **production** advisories, so the runtime surface can't silently rot again.
- Track three.js/aframe upgrades as first-class work items now that three is on an
  auditable patch stack (§1.5) and aframe has a documented migration need (§2).

---

## 7. Test coverage status

- **Added (passing):** `test/unit/utils/authorize-entity-manipulation.test.js` —
  pins the networked-entity manipulation/ownership rule (the takeover vector).
- **Recommended next:** unit tests for the NAF `authorizeOrSanitizeMessage`
  matrix, `HubChannel.can`/`userCan`, the GLTF `node.name` sanitizer and
  component-data validator, and a PDF/asset size guard. Plus a Reticulum-side test
  pinning that chat `type`/`from` and moderation ops are authorized server-side.

---

## Appendix — how the three.js findings were verified

```
# fork at pinned commit and upstream r141 (sparse, blob-filtered)
git fetch --depth 1 --filter=blob:none <fork> 65b5105…   # version 0.141.0
git fetch --depth 1 --filter=blob:none mrdoob/three.js refs/tags/r141

# examples/jsm identical (GLTFLoader stock); src diff is the 25-file stack
diff -rq upstream/examples/jsm fork/examples/jsm            # empty
git diff --no-index upstream/src fork/src                   # the patch stack

# committed bundle == rebuild from fork src
(cd fork && npm i && npm run build-module)
# normalized diff of build/three.module.js vs committed: 0 lines

# upstream npm + patch reproduces fork src
npm i three@0.141.0 && patch -p1 < patches/three+0.141.0.patch
diff -rq node_modules/three/src fork/src                    # empty
```
