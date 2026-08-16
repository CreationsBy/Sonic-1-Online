import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("GitHub Pages never parses or publishes the binary ROM", () => {
  const config = readFileSync(new URL("../_config.yml", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const clientConfig = readFileSync(new URL("../public/config.js", import.meta.url), "utf8");

  assert.match(config, /^exclude:\s*[\s\S]*?^  - rom$/m);
  assert.match(workflow, /^\s+path: public$/m);
  assert.equal(existsSync(new URL("../public/.nojekyll", import.meta.url)), true);
  assert.equal(existsSync(new URL("../public/rom", import.meta.url)), false);
  assert.doesNotMatch(page, /Multiplayer server URL|id="server-url"|id="save-server"/i);
  assert.match(clientConfig, /https:\/\/sonic-1-online\.spaghettijedi\.workers\.dev/);
  assert.match(workflow, /https:\/\/sonic-1-online\.spaghettijedi\.workers\.dev/);
  assert.doesNotMatch(workflow, /vars\.SONIC_SERVER_URL/);
});
