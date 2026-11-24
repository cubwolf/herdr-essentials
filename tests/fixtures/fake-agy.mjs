#!/usr/bin/env node
// A stand-in for `agy --input-format stream-json --output-format stream-json` in
// tests/k-chat.test.js (the events of antigravity.google/docs/cli/headless). Flags in $K_FAKE_DIR:
//   agy-mode    the permission_mode it reports     agy-writes   a write goes through in this turn
//   agy-out     not signed in
import fs from "node:fs";
import path from "node:path";
const dir = process.env.K_FAKE_DIR, args = process.argv.slice(2), has = (n) => fs.existsSync(path.join(dir, n));
let input = ""; process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const msg = JSON.parse(input.trim());
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ bin: "agy", args, cwd: process.cwd(), input: msg.message.content, via: process.env.K_FAKE_VIA ?? null }) + "\n");
const say = (o) => console.log(JSON.stringify(o));
const id = `conv-${path.basename(process.cwd())}`;
if (has("agy-out")) { say({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out" } }); process.exit(1); }
const yolo = args.includes("--dangerously-skip-permissions");
say({ event: "init", conversation_id: id, init: { cwd: process.cwd(), permission_mode: has("agy-mode") ? fs.readFileSync(path.join(dir, "agy-mode"), "utf8") : yolo ? "always-proceed" : "request-review" } });
const tool = (name, error) => say({ event: "step_update", step_update: { conversation_id: id, state: "DONE", step_type: "tool", tool_name: name, tool_info: { name, ...(error ? { error: { message: error } } : {}) } } });
tool("view_file");
tool("run_command", "denied");                      // refused: fine
if (has("agy-writes")) { tool("write_to_file"); await new Promise((r) => setTimeout(r, 5000)); }
let response = `${path.basename(process.cwd())} 的回答(Gemini)\n`, structured_output;
if (args.includes("--json-schema")) { structured_output = { conclusion: "### 決定\n- Gemini 寫的結論", todos: [] }; response = JSON.stringify(structured_output); }
say({ event: "result", result: { conversation_id: id, status: "SUCCESS", response, ...(structured_output ? { structured_output } : {}) } });
