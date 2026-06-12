import { PrefabName, prefabs } from "../prefabs/prefabs";
import { Networked } from "../bit-components";
import { createMessageDatas, isPinned } from "../bit-systems/networking";
import { authorizeEntityManipulation } from "./authorize-entity-manipulation";
import type { ClientID, EntityID } from "./networking-types";

export function hasPermissionToSpawn(creator: ClientID, prefabName: PrefabName) {
  if (creator === "reticulum") return true;
  const perm = prefabs.get(prefabName)!.permission;
  return APP.hubChannel!.userCan(creator, perm);
}

// Defense-in-depth check for the bitECS receive path. Returns true if `sender`
// is allowed to take ownership of / mutate the given network-instantiated entity.
//
// This mirrors `hasPermissionToSpawn` (and the legacy NAF
// `authorizeEntityManipulation`): a peer must not be able to claim ownership of,
// or mutate, an object that it would not have been allowed to spawn or move in
// the first place. Without this, any peer can broadcast an update message that
// claims ownership of any networked object.
//
// Entities that were not instantiated through the bitECS networking path (no
// CreateMessageData) are left to other checks and are not blocked here.
export function canManipulateNetworkedEntity(sender: ClientID, eid: EntityID): boolean {
  if (sender === "reticulum") return true;

  const data = createMessageDatas.get(eid);
  if (!data) return true;

  const prefab = prefabs.get(data.prefabName)!;
  const isCreator = Networked.creator[eid] === APP.getSid(sender);

  return authorizeEntityManipulation(
    { sender, isCreator, isPinned: isPinned(eid), manipulatePermission: prefab.permission },
    (clientId: ClientID, permission: string) => APP.hubChannel!.userCan(clientId, permission)
  );
}
