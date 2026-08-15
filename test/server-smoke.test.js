import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { SONIC_ROM } from "../public/js/protocol-constants.js";

process.env.PORT = "0";
const { server, store } = await import("../src/server.js");
if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;

async function openSocket() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function inboxFor(socket) {
  const queued = [];
  const waiting = [];
  socket.on("message", (data) => {
    if (Buffer.isBuffer(data) && !data.toString("utf8").startsWith("{")) return;
    const message = JSON.parse(data.toString());
    const waiterIndex = waiting.findIndex((waiter) => waiter.matches(message));
    if (waiterIndex === -1) queued.push(message);
    else waiting.splice(waiterIndex, 1)[0].resolve(message);
  });

  return (type, predicate = () => true) => {
    const matches = (message) => message.type === type && predicate(message);
    const queuedIndex = queued.findIndex(matches);
    if (queuedIndex !== -1) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve };
      waiting.push(waiter);
      setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index !== -1) waiting.splice(index, 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 2000).unref();
    });
  };
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("serves the app/config without exposing the ROM directory", async () => {
  const [home, config, rom] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/api/config`),
    fetch(`http://127.0.0.1:${port}/rom/Sonic%20The%20Hedgehog%20(USA,%20Europe).md`)
  ]);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Sonic 1 Online/);
  assert.equal((await config.json()).rom.sha256, SONIC_ROM.sha256);
  assert.equal(rom.status, 404);
});

test("accepts a verified player over the live WebSocket endpoint", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const firstMessage = new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "create",
    name: "Smoke Test",
    token: "smoke_test_token_000001",
    romHash: SONIC_ROM.sha256
  }));

  const messages = [await firstMessage];
  while (!messages.some((message) => message.type === "session")) {
    const message = await new Promise((resolve, reject) => {
      socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      socket.once("error", reject);
    });
    messages.push(message);
  }
  const session = messages.find((message) => message.type === "session");
  assert.match(session.lobby.code, /^\d{4}$/);
  assert.equal(session.lobby.players[0].slot, 1);
  await new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
});

test("relays on-demand live frames only after a finished player selects a teammate", async () => {
  const hostSocket = await openSocket();
  const guestSocket = await openSocket();
  const hostInbox = inboxFor(hostSocket);
  const guestInbox = inboxFor(guestSocket);

  try {
    hostSocket.send(JSON.stringify({
      type: "create",
      name: "Finished Host",
      token: "spectator_host_token_0001",
      romHash: SONIC_ROM.sha256
    }));
    const hostSession = await hostInbox("session");

    guestSocket.send(JSON.stringify({
      type: "join",
      code: hostSession.lobby.code,
      name: "Playing Guest",
      token: "spectator_guest_token_001",
      romHash: SONIC_ROM.sha256
    }));
    const guestSession = await guestInbox("session");
    const finalZone = {
      x: 800,
      y: 240,
      cameraX: 650,
      cameraY: 120,
      zoneAct: 0x0600,
      status: 0,
      visible: true
    };

    hostSocket.send(JSON.stringify({ type: "telemetry", data: { ...finalZone, mode: 0x0c } }));
    await guestInbox("telemetry");
    const hostPlayer = store.requirePlayer(store.requireLobby(hostSession.lobby.code), hostSession.lobby.selfId);
    hostPlayer.stageEnteredAt -= 9000;
    hostPlayer.lastTelemetryAt = 0;
    hostSocket.send(JSON.stringify({ type: "telemetry", data: { ...finalZone, mode: 0x18 } }));
    await hostInbox("game-finished");

    hostSocket.send(JSON.stringify({ type: "spectate", targetId: guestSession.lobby.selfId }));
    await hostInbox("spectating", (message) => message.target?.id === guestSession.lobby.selfId);
    await guestInbox("spectator-demand", (message) => message.enabled === true);

    const dataUrl = "data:image/jpeg;base64,/9j/2Q==";
    guestSocket.send(JSON.stringify({ type: "spectator-frame", dataUrl }));
    const frame = await hostInbox("spectator-frame");
    assert.equal(frame.targetId, guestSession.lobby.selfId);
    assert.equal(frame.dataUrl, dataUrl);
  } finally {
    hostSocket.close();
    guestSocket.close();
  }
});
