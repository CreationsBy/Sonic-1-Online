import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("GitHub Pages never parses or publishes the binary ROM", () => {
  const config = readFileSync(new URL("../_config.yml", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");

  assert.match(config, /^exclude:\s*[\s\S]*?^  - rom$/m);
  assert.match(workflow, /^\s+path: public$/m);
  assert.equal(existsSync(new URL("../public/.nojekyll", import.meta.url)), true);
  assert.equal(existsSync(new URL("../public/rom", import.meta.url)), false);
});
