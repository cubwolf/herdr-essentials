#!/usr/bin/env node
// A stand-in for hc in tests/k-chat.test.js:
//   exec --on M --cwd C --timeout T -i -- prog args…   runs prog here, in C
//   run … -- prog args…                                 starts nothing; logs the call, prints an address
//   connect                                             doc.get / doc.set of "herdr-app", kept in $K_FAKE_DIR/doc.json
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const a = process.argv.slice(2), cut = a.indexOf("--"), dir = process.env.K_FAKE_DIR;
const flag = (name) => a[a.indexOf(name) + 1];
if (a[0] === "run") {
  fs.appendFileSync(path.join(dir, "hc-run.jsonl"), JSON.stringify({ flags: a.slice(1, cut), argv: a.slice(cut + 1), env: { TMUX: process.env.TMUX ?? null, CLAUDECODE: process.env.CLAUDECODE ?? null } }) + "\n");
  console.log(JSON.stringify({ address: "t99", name: flag("--name") }));
} else if (a[0] === "connect") {
  const req = JSON.parse(fs.readFileSync(0, "utf8").split("\n")[0]), file = path.join(dir, "doc.json");
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { value: { spaces: [], other: "kept" }, version: 7 };
  if (req.method === "doc.get") console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: doc }));
  else if (req.method === "doc.set" && req.params.version === doc.version) {
    fs.writeFileSync(file, JSON.stringify({ value: req.params.value, version: doc.version + 1 }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { version: doc.version + 1 } }));
  } else console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { message: "conflict" } }));
} else if (a[0] === "exec" && cut > 0 && a.includes("-i")) {
  const r = spawnSync(a[cut + 1], a.slice(cut + 2), { cwd: flag("--cwd"), stdio: "inherit", env: { ...process.env, K_FAKE_VIA: `hc:${flag("--on")}` } });
  process.exit(r.status ?? 1);
} else { console.error("fake-hc: unexpected " + a.join(" ")); process.exit(2); }
