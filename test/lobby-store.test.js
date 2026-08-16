import assert from "node:assert/strict";
import test from "node:test";
import { LobbyError, LobbyStore, cleanName } from "../src/lobby-store.js";
import { SONIC_ROM } from "../public/js/protocol-constants.js";

const token = (suffix) => `player_token_${String(suffix).padStart(8, "0")}`;
const socket = () => ({ closed: null, close(code) { this.closed = code; } });

function setup() {
  let now = 1000;
  const store = new LobbyStore({ randomCode: () => 42, now: () => now });
  return { store, advance: (ms) => { now += ms; } };
}

test("creates a four-digit private room and caps it at four reserved seats", () => {
  const { store } = setup();
  const host = store.create({ name: "Amy", token: token(1), romHash: SONIC_ROM.sha256, socket: socket() });
  assert.equal(host.lobby.code, "0042");
  assert.equal(host.player.slot, 1);

  for (let index = 2; index <= 4; index += 1) {
    const joined = store.join({
      code: "0042",
      name: `Player ${index}`,
      token: token(index),
      romHash: SONIC_ROM.sha256,
      socket: socket()
    });
    assert.equal(joined.player.slot, index);
  }

  assert.throws(
    () => store.join({ code: "0042", name: "Fifth", token: token(5), romHash: SONIC_ROM.sha256, socket: socket() }),
    (error) => error instanceof LobbyError && error.code === "FULL"
  );
});

test("rejects an unsupported ROM digest and unsafe names", () => {
  const { store } = setup();
  assert.throws(
    () => store.create({ name: "Sonic", token: token(1), romHash: "bad", socket: socket() }),
    (error) => error.code === "WRONG_ROM"
  );
  assert.throws(() => cleanName("<script>"), (error) => error.code === "BAD_NAME");
});

test("a returning token keeps its player slot and checkpoint after disconnect", () => {
  const { store } = setup();
  const firstSocket = socket();
  const created = store.create({ name: "Tails", token: token(1), romHash: SONIC_ROM.sha256, socket: firstSocket });
  const checkpoint = new Uint8Array(70000).fill(7);
  store.saveCheckpoint(created.lobby.code, created.player.id, checkpoint);
  store.disconnect(firstSocket);

  const returned = store.join({
    code: created.lobby.code,
    name: "Tails",
    token: token(1),
    romHash: SONIC_ROM.sha256,
    socket: socket()
  });
  assert.equal(returned.rejoined, true);
  assert.equal(returned.player.id, created.player.id);
  assert.equal(returned.player.slot, 1);
  assert.deepEqual(returned.player.checkpoint, checkpoint);
});

test("only the host can start and all reserved seats must be connected", () => {
  const { store } = setup();
  const hostSocket = socket();
  const host = store.create({ name: "Host", token: token(1), romHash: SONIC_ROM.sha256, socket: hostSocket });
  const guestSocket = socket();
  const guest = store.join({ code: "0042", name: "Guest", token: token(2), romHash: SONIC_ROM.sha256, socket: guestSocket });

  assert.throws(() => store.beginStart("0042", guest.player.id), (error) => error.code === "NOT_HOST");
  store.disconnect(guestSocket);
  assert.throws(() => store.beginStart("0042", host.player.id), (error) => error.code === "PLAYER_OFFLINE");

  store.join({ code: "0042", name: "Guest", token: token(2), romHash: SONIC_ROM.sha256, socket: socket() });
  const lobby = store.beginStart("0042", host.player.id);
  assert.equal(lobby.status, "starting");
});

test("detects a stage clear when a player advances after meaningful play time", () => {
  const { store, advance } = setup();
  const created = store.create({ name: "Runner", token: token(1), romHash: SONIC_ROM.sha256, socket: socket() });
  const base = { x: 100, y: 300, cameraX: 0, cameraY: 200, mode: 0x0c, status: 0, visible: true };

  const entered = store.updateTelemetry("0042", created.player.id, { ...base, zoneAct: 0x0000 });
  assert.equal(entered.clear, null);
  advance(9000);
  const advanced = store.updateTelemetry("0042", created.player.id, { ...base, zoneAct: 0x0001 });
  assert.equal(advanced.clear.stage.label, "Green Hill Zone — Act 1");
  assert.equal(advanced.clear.player.name, "Runner");
});

test("marks Final Zone players as finished when Sonic 1 enters its ending", () => {
  const { store, advance } = setup();
  const created = store.create({ name: "Finisher", token: token(1), romHash: SONIC_ROM.sha256, socket: socket() });
  const base = { x: 800, y: 240, cameraX: 650, cameraY: 120, zoneAct: 0x0600, status: 0, visible: true };

  store.updateTelemetry("0042", created.player.id, { ...base, mode: 0x0c });
  advance(9000);
  const ending = store.updateTelemetry("0042", created.player.id, { ...base, mode: 0x18 });

  assert.equal(ending.clear.stage.label, "Final Zone");
  assert.equal(ending.finished.player.completedGame, true);
  assert.equal(store.snapshot(created.lobby, created.player.id).players[0].completedGame, true);
});

test("only finished players can spectate a connected unfinished teammate", () => {
  const { store, advance } = setup();
  const hostSocket = socket();
  const host = store.create({ name: "Sonic", token: token(1), romHash: SONIC_ROM.sha256, socket: hostSocket });
  const guestSocket = socket();
  const guest = store.join({ code: "0042", name: "Tails", token: token(2), romHash: SONIC_ROM.sha256, socket: guestSocket });
  const finalZone = { x: 800, y: 240, cameraX: 650, cameraY: 120, zoneAct: 0x0600, status: 0, visible: true };

  assert.throws(
    () => store.setSpectating("0042", guest.player.id, host.player.id),
    (error) => error.code === "NOT_FINISHED"
  );

  store.updateTelemetry("0042", host.player.id, { ...finalZone, mode: 0x0c });
  advance(9000);
  store.updateTelemetry("0042", host.player.id, { ...finalZone, mode: 0x18 });
  store.setSpectating("0042", host.player.id, guest.player.id);
  assert.equal(store.snapshot(host.lobby, host.player.id).players[0].spectatingId, guest.player.id);

  store.disconnect(guestSocket);
  assert.equal(store.snapshot(host.lobby, host.player.id).players[0].spectatingId, null);

  store.disconnect(hostSocket);
  const returned = store.join({
    code: "0042",
    name: "Sonic",
    token: token(1),
    romHash: SONIC_ROM.sha256,
    socket: socket()
  });
  assert.equal(returned.player.completedGame, true);
});
