import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop emulator has a definite bounded height without inherited-height feedback", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.game-shell\s*\{[^}]*height:\s*clamp\(420px,[^}]*820px\)/s);
  assert.match(css, /#game\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*max-height:\s*100%/s);
  assert.match(css, /#game\s*>\s*div[^}]*height:\s*100%[^}]*max-height:\s*100%/s);
  assert.doesNotMatch(css, /#game[^}]*min-height:\s*inherit/);
});

test("hides EmulatorJS chrome while preserving the mobile virtual gamepad", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(css, /#game \.ejs_menu_bar[^}]*display:\s*none\s*!important/);
  assert.match(css, /\.touch-device #game \.ejs_virtualGamepad_parent\s*\{[^}]*bottom:\s*0\s*!important/);
  assert.doesNotMatch(css, /\.ejs_virtualGamepad_parent[^}]*display:\s*none/);
});
