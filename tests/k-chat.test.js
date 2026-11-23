// k-chat runner (tools/k-chat): whole discussions run offline, with stand-ins for claude,
// hc and tide's task (tests/fixtures). Checks the record, the state, and what each agent was
// started with (read-only vs YOLO, resume, the other machine going through hc).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as L from "../tools/k-chat/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "..", "tools", "k-chat", "runner.mjs");
const FIX = (n) => path.join(HERE, "fixtures", n);

function setup(chair, opts = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "k-chat-"));
  const dirs = Object.fromEntries(["main", "alpha", "beta", "fake"].map((n) => [n, path.join(root, n)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  fs.writeFileSync(path.join(dirs.fake, "chair.json"), JSON.stringify(chair));
  const env = { ...process.env, K_CHAT_CLAUDE: FIX("fake-claude.mjs"), K_CHAT_HC: FIX("fake-hc.mjs"), K_CHAT_TASK: FIX("fake-task.mjs"), K_FAKE_DIR: dirs.fake, K_CHAT_TICK: "40" };
  const members = [{ space: "alpha", cwd: dirs.alpha }, { space: "beta", cwd: dirs.beta, machine: "laptop" }];
  const cli = (...args) => spawnSync("node", [RUNNER, ...args], { env, encoding: "utf8" });
  const made = cli("new", "--repo", dirs.main, "--topic", "方案 討論", "--members", JSON.stringify(members), "--say", "要用哪個方案?", ...opts);
  assert.equal(made.status, 0, made.stderr);
  const state = made.stdout.trim();
  const f = L.filesOf(state);
  const t = {
    root, dirs, env, state, f, cli,
    start() { t.proc = spawn("node", [RUNNER, "run", state], { env, stdio: "ignore" }); return t.proc; },
    s: () => JSON.parse(fs.readFileSync(state, "utf8")),
    md: () => fs.readFileSync(f.md, "utf8"),
    calls: () => { try { return fs.readFileSync(path.join(dirs.fake, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    flag: (name, on) => { const p = path.join(dirs.fake, name); if (on) fs.writeFileSync(p, ""); else fs.rmSync(p, { force: true }); },
    async until(what, ok, ms = 15000) {
      const end = Date.now() + ms;
      for (;;) {
        try { if (ok()) return; } catch {}
        if (Date.now() > end) throw new Error(`等不到:${what}\n--- record ---\n${t.md()}\n--- state ---\n${fs.readFileSync(state, "utf8")}`);
        await new Promise((r) => setTimeout(r, 30));
      }
    },
    async stop() {
      if (t.proc && t.proc.exitCode === null) { t.proc.kill("SIGTERM"); await new Promise((r) => t.proc.once("exit", r)); }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return t;
}
const pick = (next, more = {}) => ({ next, ask: `請 ${next} 說明`, yolo: false, done: false, reason: "輪到他", ...more });

test("一場討論:主席輪流點名、YOLO 只開那一輪、別台機器走 hc、結論與開卡", async () => {
  const t = setup([pick("alpha"), pick("beta", { yolo: true, reason: "談定了,請 beta 實作" }), pick("alpha")]);
  try {
    t.start();
    await t.until("結論", () => t.s().status === "done");
    const msgs = L.messages(t.md());
    assert.deepEqual(msgs.map((m) => m.role), ["owner", "chair", "member", "chair", "member", "chair", "member", "chair"]);
    assert.deepEqual(msgs.filter((m) => m.role === "member").map((m) => m.who), ["alpha@alpha", "beta@beta", "alpha@alpha"]);
    assert.equal(msgs[0].text, "要用哪個方案?");
    assert.match(msgs.at(-1).text, /結論[\s\S]*用方案甲/);
    // 🔓 那一行只出現一次,在點 beta 的那則裡
    assert.equal(t.md().split("🔓 主席授權 beta YOLO:談定了,請 beta 實作").length, 2);
    assert.equal(t.md().split("🔓").length, 2);

    const turns = t.calls().filter((c) => !c.args.includes("--json-schema"));
    assert.equal(turns.length, 3);
    const [a1, b1, a2] = turns;
    assert.ok(a1.args.includes("--tools") && a1.args.includes("--strict-mcp-config") && !a1.args.includes("--dangerously-skip-permissions"));
    assert.equal(fs.realpathSync(a1.cwd), fs.realpathSync(t.dirs.alpha));
    assert.equal(a1.via, null);
    assert.ok(b1.args.includes("--dangerously-skip-permissions") && !b1.args.includes("--tools"), "YOLO 那一輪不限工具");
    assert.equal(b1.via, "hc:laptop", "別台機器的成員走 hc exec --on");
    assert.equal(fs.realpathSync(b1.cwd), fs.realpathSync(t.dirs.beta));
    assert.match(b1.input, /授權你這一輪動手/);
    assert.ok(!a2.args.includes("--dangerously-skip-permissions") && a2.args.includes("--tools"), "下一輪恢復唯讀");
    assert.deepEqual(a2.args.slice(a2.args.indexOf("--resume"), a2.args.indexOf("--resume") + 2), ["--resume", "sess-alpha"], "第二次發言接續自己的 session");
    assert.ok(!a1.args.includes("--resume"));
    assert.match(a1.input, /你被邀請進一場多 agent 討論/);
    assert.ok(!/你被邀請進/.test(a2.input) && /beta 的回答/.test(a2.input), "之後只給上次發言以後的紀錄");
    // 主席:不給工具、用設定的模型
    const chair = t.calls().find((c) => c.args.includes("--json-schema"));
    assert.equal(chair.args[chair.args.indexOf("--model") + 1], "sonnet");
    assert.equal(chair.args[chair.args.indexOf("--tools") + 1], "");

    const s = t.s();
    assert.equal(s.round, 3);
    assert.deepEqual(s.todos.map((x) => [x.title, x.repo, x.card]), [["寫文件", "alpha", null], ["加測試", "beta", null]]);
    assert.ok(!fs.existsSync(path.join(t.dirs.fake, "task.jsonl")), "結論不會自己開卡");

    // Owner 按了才開卡
    assert.equal(t.cli("card", t.state, "1").status, 0);
    await t.until("開卡", () => t.s().todos[1].card === 999);
    const task = JSON.parse(fs.readFileSync(path.join(t.dirs.fake, "task.jsonl"), "utf8").trim());
    assert.deepEqual(task.args.slice(0, 5), ["create", "--repo", "beta", "--title", "加測試"]);
    assert.equal(task.who, "main");
    assert.match(task.body, /補單元測試[\s\S]*方案-討論\.md/);
    assert.equal(t.s().todos[0].card, null);
    assert.ok(t.md().includes("🗂 Owner 把待辦開成 Tide 卡:\n- #999 加測試(beta)"));

    // 結束後 Owner 再發言:重新開始,多給幾輪
    t.cli("say", t.state, "@beta 再補充一點");
    await t.until("重開後 beta 發言", () => t.s().round >= 4);
    assert.equal(L.messages(t.md()).filter((m) => m.role === "member").at(-1).who, "beta@beta");
    assert.ok(t.s().max_rounds >= 3 + 6);

    t.cli("quit", t.state);
    await new Promise((r) => t.proc.once("exit", r));
    assert.equal(t.s().runner, null);
  } finally { await t.stop(); }
});

test("Owner 插隊:/stop 中止這一輪,@某人 讓他下一個發言、不經主席", async () => {
  const t = setup([pick("alpha"), pick("alpha"), pick("alpha")]);
  try {
    t.flag("slow-alpha", true);            // alpha 的第一輪卡住,這時 Owner 發言
    t.start();
    await t.until("alpha 發言中", () => t.s().now?.phase === "member" && t.s().now.who === "alpha");
    t.cli("say", t.state, "/stop");
    await t.until("停下來", () => /⏹ Owner 中止了這一輪/.test(t.md()) && t.s().status === "waiting" && t.s().now.phase === "waiting");
    assert.ok(!/alpha 的回答/.test(t.md()), "被中止的那一輪沒有回答");
    assert.equal(t.s().round, 0);
    t.flag("slow-alpha", false);
    t.cli("say", t.state, "@beta 請說");
    await t.until("beta 回答", () => /beta 的回答/.test(t.md()));
    const msgs = L.messages(t.md());
    const i = msgs.findIndex((m) => m.text === "@beta 請說");
    assert.equal(msgs[i].role, "owner");
    assert.equal(msgs[i + 1].who, "beta@beta", "Owner 點名後直接是他,中間沒有主席");
    const b = t.calls().filter((c) => !c.args.includes("--json-schema")).find((c) => c.via === "hc:laptop");
    assert.match(b.input, /Owner 點名你回答/);
    assert.ok(b.args.includes("--tools"), "Owner 點名的那一輪是唯讀");
  } finally { await t.stop(); }
});

test("關掉主持程式再開:接著跑;同時開兩個會被擋", async () => {
  const t = setup([pick("alpha"), pick("beta"), pick("alpha"), pick("beta")]);
  try {
    t.flag("slow-beta", true);
    t.start();
    await t.until("beta 發言中", () => t.s().now?.who === "beta" && t.s().round === 1);
    const second = spawnSync("node", [RUNNER, "run", t.state], { env: t.env, encoding: "utf8" });
    assert.equal(second.status, 3);
    assert.match(second.stderr, /已經有主持程式在跑/);
    t.proc.kill("SIGTERM");
    await new Promise((r) => t.proc.once("exit", r));
    assert.equal(t.s().runner, null);
    assert.equal(t.s().status, "running");
    t.flag("slow-beta", false);
    t.start();
    await t.until("跑完", () => t.s().status === "done");
    assert.equal(t.s().members.find((m) => m.name === "alpha").session, "sess-alpha");
    assert.equal(t.md().split("# Chat:").length, 2, "標頭只寫一次");
    assert.ok(L.messages(t.md()).filter((m) => m.role === "member").length >= 3);
  } finally { await t.stop(); }
});

test("輪數上限、關掉 YOLO、中途邀請、失敗會記下來", async () => {
  const t = setup([pick("alpha", { yolo: true }), pick("beta"), pick("alpha"), pick("alpha")], ["--max-rounds", "2", "--no-yolo"]);
  try {
    t.start();
    await t.until("到上限收尾", () => t.s().status === "done");
    assert.equal(t.s().round, 2);
    assert.ok(!t.md().includes("🔓"), "關掉後主席開不了 YOLO");
    assert.ok(t.calls().every((c) => !c.args.includes("--dangerously-skip-permissions")));
    assert.ok(t.md().includes("### 結論\n\n> 到了 2 輪上限\n\n#### 決定"));

    const gamma = path.join(t.root, "gamma"); fs.mkdirSync(gamma);
    t.cli("invite", t.state, JSON.stringify({ space: "gamma", cwd: gamma }));
    t.flag("fail-gamma", true);
    t.cli("say", t.state, "@gamma 歡迎,你怎麼看?");
    await t.until("gamma 失敗被記下", () => /⚠️ gamma 這一輪失敗:壞掉了/.test(t.md()));
    assert.match(t.md(), /➕ gamma@gamma 加入討論/);
    assert.equal(t.s().members.length, 3);
  } finally { await t.stop(); }
});

test("start:在 herdr-core 開自己的 terminal(hc run --keep),並寫進 Herdr App 排版;list 列得出來", async () => {
  const t = setup([]);
  try {
    const env = { ...t.env, TMUX: "/tmp/x,1,0", CLAUDECODE: "1" };
    const r = spawnSync("node", [RUNNER, "start", t.state], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.started, out.address, out.in_app_layout], [true, "t99", true]);
    assert.match(out.terminal, /^kchat-[0-9a-f]{8}$/);
    const call = JSON.parse(fs.readFileSync(path.join(t.dirs.fake, "hc-run.jsonl"), "utf8").trim());
    // hc 的旗標都在 -- 前面,後面才是程式
    for (const f of ["--bg", "--keep", "--no-parent", "--name", "--cwd"]) assert.ok(call.flags.includes(f), f);
    assert.equal(call.flags[call.flags.indexOf("--cwd") + 1], t.dirs.main);
    assert.deepEqual(call.argv.slice(1), [RUNNER, "run", t.state].map((x, i) => (i === 0 ? fs.realpathSync(x) : x)));
    assert.deepEqual(call.env, { TMUX: null, CLAUDECODE: null }, "子程序不帶這個 session 的 TMUX / CLAUDECODE");
    const doc = JSON.parse(fs.readFileSync(path.join(t.dirs.fake, "doc.json"), "utf8"));
    assert.equal(doc.version, 8);
    assert.equal(doc.value.other, "kept", "排版文件其他欄位原樣留著");
    const [sp] = doc.value.spaces;
    assert.equal(sp.folder, t.dirs.main);
    assert.equal(sp.tabs[0].root.children[0].content.terminal, "t99");
    assert.equal(sp.tabs[0].name, "chat: 方案 討論");
    // 已經在排版裡就不重複加
    const again = JSON.parse(spawnSync("node", [RUNNER, "start", t.state], { env, encoding: "utf8" }).stdout);
    assert.equal(again.in_app_layout, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dirs.fake, "doc.json"), "utf8")).value.spaces[0].tabs.length, 1);

    const list = JSON.parse(t.cli("list", "--repo", t.dirs.main).stdout);
    assert.deepEqual(list.map((x) => [x.title, x.status, x.round, x.members]), [["方案 討論", "running", 0, ["alpha", "beta"]]]);
    assert.equal(list[0].path, t.state);
  } finally { await t.stop(); }
});

test("lib:Owner 的話、主席的回答、紀錄格式", () => {
  const names = ["alpha", "beta"];
  assert.deepEqual(L.parseSay("/stop", names), { text: "/stop", stop: true, end: false, mentions: [] });
  assert.equal(L.parseSay("/end 收一收", names).end, true);
  assert.equal(L.parseSay("/stopwatch 是什麼", names).stop, false);
  assert.deepEqual(L.parseSay("@beta、@alpha 還有 @nobody,@beta 再一次", names).mentions, ["beta", "alpha"]);
  assert.equal(L.slug(" a/b: c "), "a-b-c");
  assert.throws(() => L.slug("  "));
  assert.deepEqual(L.members([{ space: "x", cwd: "/a" }, { space: "x", cwd: "/b", machine: "laptop" }, { space: "x", cwd: "/c" }]).map((m) => m.name), ["x", "x-laptop", "x-2"]);
  const s = L.newState({ repo: "/r/main", topic: "t", list: [{ space: "alpha", cwd: "/a" }, { space: "beta", cwd: "/b" }] });
  assert.equal(L.turnFrom(s, { next: "@beta", ask: "q", yolo: true }, null).yolo, true);
  assert.equal(L.turnFrom({ ...s, allow_yolo: false }, { next: "beta", yolo: true }, null).yolo, false);
  assert.equal(L.turnFrom(s, { next: "不存在" }, "alpha").next, "beta", "點到不存在的人:換下一位");
  assert.equal(L.turnFrom(s, { next: "Owner" }, null).next, "owner");
  const md = L.header(s) + L.entry("owner", "嗨") + L.entry("chair", "→ **@alpha**:說說看") + L.entry(s.members[0], "好\n\n### 小標不是新訊息");
  // porthole 的 #chat 用同一個規則切訊息
  assert.equal([...md.matchAll(/^## (🧑 Human|🤖 Assistant)[^\n]*$/gm)].length, 3);
  assert.deepEqual(L.messages(md).map((m) => [m.role, m.who]), [["owner", "Owner"], ["chair", "主席"], ["member", "alpha@alpha"]]);
  assert.ok(L.memberArgv({ agent: "claude", fork: "abc" }, false).args.join(" ").includes("--resume abc --fork-session"));
  assert.deepEqual(L.memberArgv({ agent: "codex", session: "th1" }, false).args, ["exec", "resume", "th1", "--json", "--sandbox", "read-only", "-"]);
  assert.equal(L.parseReply("claude", 'banner\n{"result":"hi","session_id":"s1"}\n').session, "s1");
  assert.throws(() => L.parseReply("claude", '{"is_error":true,"result":"no"}'), /no/);
});
