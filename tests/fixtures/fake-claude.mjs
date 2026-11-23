#!/usr/bin/env node
// A stand-in for `claude -p` in tests/k-chat.test.js. The chair (--json-schema) answers from
// $K_FAKE_DIR/chair.json in order; a member answers with its folder's name. Every call's
// arguments, folder and prompt are appended to $K_FAKE_DIR/calls.jsonl.
import fs from "node:fs";
import path from "node:path";
const dir = process.env.K_FAKE_DIR, args = process.argv.slice(2);
let input = ""; process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const calls = path.join(dir, "calls.jsonl");
const n = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
fs.appendFileSync(calls, JSON.stringify({ args, cwd: process.cwd(), input, via: process.env.K_FAKE_VIA ?? null }) + "\n");
const schema = args.includes("--json-schema") ? JSON.parse(args[args.indexOf("--json-schema") + 1]) : null;
if (schema) {
  if (schema.properties.conclusion) {
    console.log(JSON.stringify({ result: "", structured_output: { conclusion: "### 決定\n- 用方案甲\n\n### 還沒談定\n無\n\n### 待辦\n- alpha 寫文件", todos: [{ title: "寫文件", repo: "alpha", detail: "補 README" }, { title: "加測試", repo: "beta", detail: "補單元測試" }] } }));
  } else {
    const file = path.join(dir, "chair.json"), at = path.join(dir, "chair.at");
    const list = JSON.parse(fs.readFileSync(file, "utf8")), i = fs.existsSync(at) ? Number(fs.readFileSync(at, "utf8")) : 0;
    fs.writeFileSync(at, String(i + 1));
    console.log(JSON.stringify({ result: "", structured_output: list[i] ?? { next: "", ask: "", yolo: false, done: true, reason: "談完了" } }));
  }
} else {
  const who = path.basename(process.cwd());
  if (fs.existsSync(path.join(dir, `slow-${who}`))) await new Promise((r) => setTimeout(r, 60000));
  if (fs.existsSync(path.join(dir, `fail-${who}`))) { console.log(JSON.stringify({ is_error: true, result: "壞掉了" })); process.exit(1); }
  console.log(JSON.stringify({ result: `${who} 的回答 #${n}`, session_id: `sess-${who}` }));
}
