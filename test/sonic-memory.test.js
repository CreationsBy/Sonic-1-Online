import assert from "node:assert/strict";
import test from "node:test";
import { RAM, findWorkRam, readSonicTelemetry } from "../public/js/sonic-memory.js";

function makeState() {
  const state = new Uint8Array(16 + 0x10000 + 64);
  state.set(new TextEncoder().encode("GENPLUS-GX 1.7.5"), 0);
  const ram = state.subarray(16, 16 + 0x10000);
  const word = (address, value) => {
    ram[address] = value & 0xff;
    ram[address + 1] = value >>> 8;
  };
  const byte = (address, value) => { ram[address ^ 1] = value; };
  return { state, ram, word, byte };
}

test("finds Genesis work RAM directly after the serialized core signature", () => {
  const { state, ram } = makeState();
  assert.deepEqual(findWorkRam(state), ram);
});

test("reads Sonic, camera, game mode, facing status, and stage from work RAM", () => {
  const { state, word, byte } = makeState();
  word(RAM.sonicX, 1234);
  word(RAM.sonicY, 456);
  word(RAM.cameraX, 1000);
  word(RAM.cameraY, 300);
  word(RAM.zoneAct, 0x0001);
  byte(RAM.sonicObject, 1);
  byte(RAM.sonicStatus, 1);
  byte(RAM.gameMode, 0x0c);

  const telemetry = readSonicTelemetry(state);
  assert.equal(telemetry.x, 1234);
  assert.equal(telemetry.cameraX, 1000);
  assert.equal(telemetry.visible, true);
  assert.equal(telemetry.status, 1);
  assert.equal(telemetry.stage.label, "Green Hill Zone — Act 2");
});

test("does not mark Sonic visible outside level mode", () => {
  const { state, word, byte } = makeState();
  word(RAM.zoneAct, 0x0000);
  byte(RAM.sonicObject, 1);
  byte(RAM.gameMode, 0x04);
  assert.equal(readSonicTelemetry(state).visible, false);
});
