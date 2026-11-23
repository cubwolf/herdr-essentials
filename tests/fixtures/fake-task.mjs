#!/usr/bin/env node
// A stand-in for tide's bin/task: `create` prints a card number.
import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(path.join(process.env.K_FAKE_DIR, "task.jsonl"), JSON.stringify({ args: process.argv.slice(2), who: process.env.TASK_WHO, body: fs.readFileSync(0, "utf8") }) + "\n");
console.log("#999 已建立");
