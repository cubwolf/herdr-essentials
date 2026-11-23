#!/usr/bin/env node
// A stand-in for `hc exec --on M --cwd C --timeout T -i -- prog args…`: runs prog here, in C.
import { spawnSync } from "node:child_process";
const a = process.argv.slice(2), cut = a.indexOf("--");
const flag = (name) => a[a.indexOf(name) + 1];
if (a[0] !== "exec" || cut < 0 || !a.includes("-i")) { console.error("fake-hc: unexpected " + a.join(" ")); process.exit(2); }
const r = spawnSync(a[cut + 1], a.slice(cut + 2), { cwd: flag("--cwd"), stdio: "inherit", env: { ...process.env, K_FAKE_VIA: `hc:${flag("--on")}` } });
process.exit(r.status ?? 1);
