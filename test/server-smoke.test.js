import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { SONIC_ROM } from "../public/js/protocol-constants.js";

process.env.PORT = "0";
const { server } = await import("../src/server.js");
if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;

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
  assert.match(await home.text(), /Sonic Online Race/);
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
