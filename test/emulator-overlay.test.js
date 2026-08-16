import assert from "node:assert/strict";
import test from "node:test";
import { drawNameTag, NATIVE_SPEED_OPTIONS, TELEMETRY_INTERVAL_MS } from "../public/js/emulator.js";

test("uses native-speed emulator settings with low-overhead telemetry", () => {
  assert.deepEqual(NATIVE_SPEED_OPTIONS, {
    vsync: "enabled",
    fastForward: "disabled",
    slowMotion: "disabled",
    rewindEnabled: "disabled",
    shader: "disabled",
    fps: "hide"
  });
  assert.equal(TELEMETRY_INTERVAL_MS, 250);
});

test("draws a clamped player name using the matching Sonic color", () => {
  const calls = [];
  const context = {
    save() {},
    restore() {},
    measureText: () => ({ width: 40 }),
    strokeText(text, x, y) { calls.push({ kind: "stroke", text, x, y, color: this.strokeStyle }); },
    fillText(text, x, y) { calls.push({ kind: "fill", text, x, y, color: this.fillStyle }); }
  };

  drawNameTag(context, "Player Two", -20, -10, "#ff3d52");

  assert.deepEqual(calls, [
    { kind: "stroke", text: "Player Two", x: 23, y: 10, color: "#061329" },
    { kind: "fill", text: "Player Two", x: 23, y: 10, color: "#ff3d52" }
  ]);
});
