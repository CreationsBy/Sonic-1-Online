import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Cloudflare deploys the multiplayer Worker instead of auto-detecting Jekyll", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

  assert.equal(config.main, "cloudflare/worker.js");
  assert.equal(config.durable_objects.bindings[0].name, "LOBBIES");
  assert.equal(config.durable_objects.bindings[0].class_name, "SonicLobbyHub");
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ["SonicLobbyHub"]);
  assert.equal("assets" in config, false);
});
