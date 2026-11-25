// node --test tests/
// k-agents' model.js (which model an agent runs, and its icon) and the copies other mods carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { modelOf, effortLevel, modelTip, MODELS } from "../mods/k-agents/model.js";

const mods = join(dirname(fileURLToPath(import.meta.url)), "..", "mods");
const copies = readdirSync(mods).filter((m) => m !== "k-agents" && existsSync(join(mods, m, "model.js")));

test("every copy of model.js and of its icons equals k-agents'", () => {
  assert.ok(copies.includes("k-pane"), "k-pane carries a copy");
  const files = ["model.js", ...MODELS.map(([, kind]) => `m-${kind}.svg`)];
  for (const m of copies) for (const f of files) {
    assert.ok(existsSync(join(mods, m, f)), `mods/${m}/${f} is missing: cp mods/k-agents/${f} mods/${m}/`);
    assert.equal(readFileSync(join(mods, m, f), "utf8"), readFileSync(join(mods, "k-agents", f), "utf8"), `mods/${m}/${f} is out of date: cp mods/k-agents/${f} mods/${m}/`);
  }
});

test("modelOf: Claude Code's labels", () => {
  const m = modelOf({ labels: { "herdr.model": "Fable 5.2", "herdr.effort": "High" } }, "mods/k-pane");
  assert.deepEqual(m, { model: "Fable 5.2", effort: "high", kind: "fable", icon: "mods/k-pane/m-fable.svg", color: "#a970ff" });
  assert.equal(modelTip(m), "Fable 5.2 · high");
  assert.equal(modelOf({ labels: { "herdr.model": "Opus 5.5" } }, "d").icon, "d/m-opus.svg");
});

test("modelOf: Codex from its command line, also under a shell", () => {
  const m = modelOf({ foreground: { argv: ["/usr/bin/codex", "-m", "gpt-5-codex", "-c", 'model_reasoning_effort="xhigh"'] } }, "d");
  assert.equal(m.kind, "codex");
  assert.equal(m.effort, "xhigh");
  assert.equal(modelOf({ argv: ["codex", "--model=gpt-5-mini"] }, "d").kind, "mini");
  assert.equal(modelOf({ argv: ["codex"] }, "d"), null);
});

test("modelOf: nothing known, or a model without an icon", () => {
  assert.equal(modelOf(undefined, "d"), null);
  assert.equal(modelOf({ labels: {} }, "d"), null);
  assert.equal(modelOf({ labels: { "herdr.model": "Llama" } }, "d").icon, null);
  assert.equal(modelTip(null), "");
});

test("effortLevel", () => {
  assert.deepEqual(["low", "medium", "high", "xhigh", "max", null].map(effortLevel), [0, 1, 2, 3, 3, 0]);
});
