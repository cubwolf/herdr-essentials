#!/usr/bin/env node
// A stand-in for `codex exec --json` in tests/k-chat.test.js. Like the real one, `resume` takes no
// --sandbox after it. With --output-schema it answers as the chair ($K_FAKE_DIR/chair.json, through
// the same counter as fake-claude), as text. Calls go to $K_FAKE_DIR/calls.jsonl.
import fs from "node:fs";
import path from "node:path";
const dir = process.env.K_FAKE_DIR, args = process.argv.slice(2);
let input = ""; process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ bin: "codex", args, cwd: process.cwd(), input, via: process.env.K_FAKE_VIA ?? null }) + "\n");
const after = args.includes("resume") ? args.slice(args.indexOf("resume")) : [];
if (args[0] !== "exec" || args.at(-1) !== "-" || after.includes("--sandbox")) { console.error("error: unexpected argument"); process.exit(2); }
const say = (o) => console.log(JSON.stringify(o));
say({ type: "thread.started", thread_id: `th-${path.basename(process.cwd())}` });
say({ type: "turn.started" });
let text = `${path.basename(process.cwd())} 的回答(Codex)`;
if (args.includes("--output-schema")) {
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
  if (schema.properties.conclusion) text = JSON.stringify({ conclusion: "### 決定\n- Codex 寫的結論", todos: [] });
  else {
    const at = path.join(dir, "chair.at"), list = JSON.parse(fs.readFileSync(path.join(dir, "chair.json"), "utf8")), i = fs.existsSync(at) ? Number(fs.readFileSync(at, "utf8")) : 0;
    fs.writeFileSync(at, String(i + 1));
    text = "```json\n" + JSON.stringify(list[i] ?? { next: "", ask: "", yolo: false, done: true, reason: "談完了" }) + "\n```";
  }
}
say({ type: "item.completed", item: { id: "i1", type: "agent_message", text } });
say({ type: "turn.completed", usage: {} });
