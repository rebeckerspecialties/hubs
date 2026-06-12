// Authorization core shared by the networking receive paths.
//
// This module is intentionally dependency-free so it can be unit tested in
// isolation (see test/unit/utils/authorize-entity-manipulation.test.js) and
// reused by both the legacy NAF receive path and the bitECS receive path.
//
// A networked entity may be manipulated (moved, mutated, re-owned or removed)
// by `sender` when ALL of the following hold:
//   - the update originates from reticulum (server authoritative), OR the
//     sender created the entity, OR the sender holds the permission required to
//     spawn/move that kind of entity; AND
//   - if the entity is pinned, the sender additionally holds `pin_objects`.
//
// This mirrors the rule already enforced for the legacy NAF path in
// permissions-utils.js (`authorizeEntityManipulation`) and the spawn-time check
// in permissions.ts (`hasPermissionToSpawn`).
//
// `userCan(clientId, permission)` is injected and must return a boolean. Keeping
// it as a parameter avoids any dependency on the hub channel / presence state so
// the rule can be exercised deterministically in tests.
//
// NOTE: This is a defense-in-depth control. Because every client evaluates it
// independently against the server-attributed sender id, a maliciously modified
// peer cannot make honest clients accept an ownership/manipulation it is not
// entitled to. It does NOT replace authoritative enforcement in Reticulum.

export function authorizeEntityManipulation({ sender, isCreator, isPinned, manipulatePermission }, userCan) {
  if (sender === "reticulum") return true;

  const pinnedOk = !isPinned || userCan(sender, "pin_objects");
  const manipulateOk = isCreator || userCan(sender, manipulatePermission);

  return pinnedOk && manipulateOk;
}
