import test from "ava";
import { authorizeEntityManipulation } from "../../../src/utils/authorize-entity-manipulation";

// Helper: build a userCan(clientId, permission) backed by a plain map of granted permissions.
function userCanFor(granted) {
  return (clientId, permission) => !!(granted[clientId] && granted[clientId][permission]);
}

const NOBODY_CAN = () => false;

test("reticulum is always authorized, even with no permissions", t => {
  t.true(
    authorizeEntityManipulation(
      { sender: "reticulum", isCreator: false, isPinned: true, manipulatePermission: "spawn_and_move_media" },
      NOBODY_CAN
    )
  );
});

test("creator may manipulate their own (unpinned) entity without the move permission", t => {
  t.true(
    authorizeEntityManipulation(
      { sender: "alice", isCreator: true, isPinned: false, manipulatePermission: "spawn_and_move_media" },
      NOBODY_CAN
    )
  );
});

test("non-creator without the move permission is denied (the takeover vector)", t => {
  t.false(
    authorizeEntityManipulation(
      { sender: "mallory", isCreator: false, isPinned: false, manipulatePermission: "spawn_and_move_media" },
      NOBODY_CAN
    )
  );
});

test("non-creator with the move permission is allowed for an unpinned entity", t => {
  const userCan = userCanFor({ bob: { spawn_and_move_media: true } });
  t.true(
    authorizeEntityManipulation(
      { sender: "bob", isCreator: false, isPinned: false, manipulatePermission: "spawn_and_move_media" },
      userCan
    )
  );
});

test("pinned entity additionally requires pin_objects", t => {
  // Has move permission but NOT pin_objects -> denied because the entity is pinned.
  const moveOnly = userCanFor({ bob: { spawn_and_move_media: true } });
  t.false(
    authorizeEntityManipulation(
      { sender: "bob", isCreator: false, isPinned: true, manipulatePermission: "spawn_and_move_media" },
      moveOnly
    )
  );

  // Has both move permission and pin_objects -> allowed.
  const moveAndPin = userCanFor({ bob: { spawn_and_move_media: true, pin_objects: true } });
  t.true(
    authorizeEntityManipulation(
      { sender: "bob", isCreator: false, isPinned: true, manipulatePermission: "spawn_and_move_media" },
      moveAndPin
    )
  );
});

test("creator of a pinned entity still needs pin_objects to manipulate it", t => {
  // isCreator satisfies the manipulate clause, but pinned still requires pin_objects.
  t.false(
    authorizeEntityManipulation(
      { sender: "alice", isCreator: true, isPinned: true, manipulatePermission: "spawn_and_move_media" },
      NOBODY_CAN
    )
  );
  const withPin = userCanFor({ alice: { pin_objects: true } });
  t.true(
    authorizeEntityManipulation(
      { sender: "alice", isCreator: true, isPinned: true, manipulatePermission: "spawn_and_move_media" },
      withPin
    )
  );
});

test("the manipulate permission is specific to the prefab kind", t => {
  // A user who may move media but not spawn cameras cannot take over a camera entity.
  const mediaOnly = userCanFor({ bob: { spawn_and_move_media: true } });
  t.false(
    authorizeEntityManipulation(
      { sender: "bob", isCreator: false, isPinned: false, manipulatePermission: "spawn_camera" },
      mediaOnly
    )
  );
  const cameraOk = userCanFor({ bob: { spawn_camera: true } });
  t.true(
    authorizeEntityManipulation(
      { sender: "bob", isCreator: false, isPinned: false, manipulatePermission: "spawn_camera" },
      cameraOk
    )
  );
});

test("a user with no presence/permissions (userCan always false) cannot manipulate others' entities", t => {
  t.false(
    authorizeEntityManipulation(
      { sender: "ghost", isCreator: false, isPinned: false, manipulatePermission: "spawn_and_move_media" },
      NOBODY_CAN
    )
  );
});
