// Tests for k-float (run: node --test tests/).
// A mod can only import from its own folder ("resolves outside the application directory"), so every
// mod that uses the SDK carries a copy of mods/k-float/float.js. They must stay the same file:
//   cp mods/k-float/float.js mods/<mod>/float.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const mods = join(dirname(fileURLToPath(import.meta.url)), "..", "mods");
const source = readFileSync(join(mods, "k-float", "float.js"), "utf8");

test("every copy of float.js equals mods/k-float/float.js", () => {
  const copies = readdirSync(mods).filter((m) => m !== "k-float" && existsSync(join(mods, m, "float.js")));
  assert.ok(copies.includes("k-note"), "k-note carries a copy");
  for (const m of copies) assert.equal(readFileSync(join(mods, m, "float.js"), "utf8"), source, `mods/${m}/float.js is out of date: cp mods/k-float/float.js mods/${m}/float.js`);
});

test("no mod imports float.js from another mod's folder", () => {
  for (const m of readdirSync(mods)) {
    for (const f of readdirSync(join(mods, m)).filter((f) => f.endsWith(".js"))) {
      assert.doesNotMatch(readFileSync(join(mods, m, f), "utf8"), /from\s+["']\.\.\/[^"']*float\.js["']/, `mods/${m}/${f}`);
    }
  }
});
