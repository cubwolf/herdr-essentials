#!/usr/bin/env node
// k-chat runner (herdr-essentials, ADR 0004, Tide #293): hosts one multi-agent discussion.
// Each round: take the Owner's messages, ask the chair who speaks, run that member's agent
// headless in its own folder (on its own machine), write the answer to doc/chat/<topic>.md.
//
//   runner.mjs new --repo DIR --topic NAME --members JSON [--title T] [--space S] [--say TEXT]
//                  [--max-rounds N] [--chair-model M] [--no-yolo]     make the files, print the state path
//   runner.mjs list --repo DIR         that repo's discussions, as JSON
//   runner.mjs start <state.json>      host it in a herdr-core terminal of its own (hc run --keep), shown in the Herdr App
//   runner.mjs run <state.json>        host it here, in this terminal (picks up where it stopped)
//   runner.mjs say <state.json> TEXT   the Owner speaks (/stop, /end, @member)
//   runner.mjs invite <state.json> JSON   add a member: { name?, space, machine?, cwd, agent?, fork? }
//   runner.mjs set <state.json> allow_yolo=false|max_rounds=20|chair_model=haiku
//   runner.mjs card <state.json> 0,2   open Tide cards for those to-dos of the conclusion
//   runner.mjs quit <state.json>       the runner leaves (the record stays)
//
// Only the runner writes the state and the record; everything else goes through the inbox
// (doc/chat/<topic>.inbox/), so a window can close and open again without losing anything.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import * as L from "./lib.mjs";

const CLAUDE = process.env.K_CHAT_CLAUDE || "claude";
const CODEX = process.env.K_CHAT_CODEX || "codex";
const HC = process.env.K_CHAT_HC || "hc";
const TICK = Number(process.env.K_CHAT_TICK) || 1000;
const REOPEN = 6; // rounds an Owner message adds to a discussion that had ended

// A child's environment: not this terminal's tmux or Claude Code session.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "TMUX" || k === "TMUX_PANE" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

// Runs one program to its end with `input` on stdin. `stop()` is asked every tick: true ends it.
// On another machine it goes through herdr-core (hc exec), which caps a run at 10 minutes.
function run({ bin, args, cwd, machine, input, timeout, stop }) {
  const real = bin === "claude" ? CLAUDE : bin === "codex" ? CODEX : bin;
  const [cmd, argv] = machine
    ? [HC, ["exec", "--on", machine, "--cwd", cwd, "--timeout", String(Math.min(600, Math.ceil(timeout / 1000))), "-i", "--", real, ...args]]
    : [real, args];
  return new Promise((resolve) => {
    let out = "", err = "", stopped = false, over = false;
    const child = spawn(cmd, argv, { cwd: machine ? undefined : cwd, env: childEnv(), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const end = () => { try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} } };
    const timer = setInterval(() => { if (stop?.()) { stopped = true; end(); } }, TICK);
    const limit = setTimeout(() => { over = true; end(); }, timeout);
    current = end;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { err += String(e?.message ?? e); });
    child.on("close", (code) => {
      clearInterval(timer); clearTimeout(limit); current = null;
      resolve({ code: code ?? 1, stdout: out, stderr: err, stopped, over });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
let current = null; // ends the program that is running now

class Stopped extends Error {}

async function agent(spec, opts) {
  const r = await run({ ...spec, ...opts });
  if (r.stopped) throw new Stopped();
  if (r.over) throw new Error(`超過 ${Math.round(opts.timeout / 60000)} 分鐘沒講完`);
  try { return L.parseReply(spec.bin === "codex" ? "codex" : "claude", r.stdout); }
  catch (e) { throw new Error(r.code !== 0 ? `${e.message}${r.stderr.trim() ? ` · ${r.stderr.trim().slice(-300)}` : ""}` : e.message); }
}

function host(statePath) {
  const f = L.filesOf(statePath);
  let s = L.load(statePath);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (s.runner?.pid && s.runner.pid !== process.pid && s.runner.host === os.hostname() && alive(s.runner.pid) && Date.now() - (s.runner.at ?? 0) < 30000) {
    console.error(`這場討論已經有主持程式在跑(pid ${s.runner.pid})`);
    process.exit(3);
  }
  fs.mkdirSync(f.inbox, { recursive: true });
  if (!fs.existsSync(f.md)) fs.writeFileSync(f.md, L.header(s));

  const record = () => fs.readFileSync(f.md, "utf8");
  const write = (who, text) => { fs.appendFileSync(f.md, L.entry(who, text)); console.log(`[${L.clock()}] ${who === "owner" ? "Owner" : who === "chair" ? "主席" : who.name}: ${String(text).trim().split("\n")[0].slice(0, 100)}`); };
  const beat = () => { s.runner = { pid: process.pid, host: os.hostname(), at: Date.now() }; L.save(statePath, s); };
  const now = (phase, who = null, yolo = false) => { s.now = { phase, who, yolo, since: Date.now() }; beat(); };
  const member = (name) => s.members.find((m) => m.name === name);
  const lastSpeaker = () => s.last ?? null;

  const pulse = setInterval(beat, 5000);
  const leave = (code) => { clearInterval(pulse); current?.(); s.runner = null; s.now = { phase: "idle", who: null, since: Date.now() }; L.save(statePath, s); process.exit(code); };
  process.on("SIGTERM", () => leave(0));
  process.on("SIGINT", () => leave(0));

  // /stop waiting in the inbox ends the turn that is running.
  const stopAsked = () => L.peek(f.inbox).some((g) => g.msg?.type === "say" && L.parseSay(g.msg.text, []).stop);

  // Everything waiting in the inbox, in order. Returns { end, quit }.
  function inbox() {
    const got = { end: false, quit: false };
    for (const msg of L.take(f.inbox)) {
      if (msg.type === "quit") got.quit = true;
      else if (msg.type === "invite") {
        try {
          const [m] = L.members([msg.member], s.members.map((x) => x.name));
          m.seen = 0; s.members.push(m);
          write("chair", `➕ ${m.name}@${m.space} 加入討論${m.machine ? `(機器 ${m.machine})` : ""}。`);
        } catch (e) { write("chair", `⚠️ 邀請失敗:${e.message}`); }
      } else if (msg.type === "set") {
        if (typeof msg.allow_yolo === "boolean") { s.allow_yolo = msg.allow_yolo; write("chair", msg.allow_yolo ? "🔐 Owner 允許主席開 YOLO。" : "🔒 Owner 關掉了主席開 YOLO 的權力。"); }
        if (Number(msg.max_rounds) > 0) s.max_rounds = Number(msg.max_rounds);
        if (typeof msg.chair_model === "string" && msg.chair_model) s.chair.model = msg.chair_model;
      } else if (msg.type === "card") cards(msg.todos ?? []);
      else if (msg.type === "say" && String(msg.text ?? "").trim()) {
        const say = L.parseSay(msg.text, s.members.map((m) => m.name));
        write("owner", say.text);
        if (say.stop) { s.queue = []; s.status = "waiting"; continue; }
        if (say.end) { got.end = true; continue; }
        for (const name of say.mentions) s.queue.push({ next: name, ask: say.text, yolo: false, done: false, reason: "", from: "owner" });
        if (s.status === "done") { s.max_rounds = Math.max(s.max_rounds, s.round + REOPEN); s.todos = s.todos.filter((t) => t.card); }
        s.status = "running"; s.failures = 0;
      }
    }
    return got;
  }

  // Tide cards for the conclusion's to-dos the Owner picked (never on the chair's own say-so).
  function cards(picked) {
    const who = (() => { try { return JSON.parse(fs.readFileSync(path.join(s.repo, ".claude", "tide.json"), "utf8")).ap; } catch { return null; } })() || path.basename(s.repo);
    const made = [];
    for (const i of picked) {
      const t = s.todos[i];
      if (!t || t.card) continue;
      const m = s.members.find((x) => x.name === t.repo || x.space === t.repo);
      const repo = m ? m.cwd.split(/[\\/]/).filter(Boolean).pop() : t.repo;
      const body = `${t.detail}\n\n來源:k-chat 討論「${s.title}」的結論(\`${path.relative(s.repo, f.md)}\`,repo ${path.basename(s.repo)})。\n`;
      const r = spawnTask(["create", "--repo", repo, "--title", t.title, "--body-file", "-"], body, who);
      const id = /#(\d+)/.exec(r.stdout)?.[1];
      if (r.code === 0 && id) { t.card = Number(id); made.push(`#${id} ${t.title}(${repo})`); }
      else made.push(`⚠️ 沒開成「${t.title}」:${(r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 200) ?? "?"}`);
    }
    if (made.length) write("chair", `🗂 Owner 把待辦開成 Tide 卡:\n${made.map((x) => `- ${x}`).join("\n")}`);
  }

  async function conclude(why) {
    now("conclude");
    try {
      const r = await agent(L.chairArgv(s.chair.model, L.CONCLUDE_SCHEMA), { cwd: s.repo, input: L.concludePrompt(s, record()), timeout: 5 * 60000, stop: stopAsked });
      const c = r.structured ?? JSON.parse(r.text);
      s.todos = [...s.todos.filter((t) => t.card), ...(c.todos ?? []).map((t) => ({ title: String(t.title), repo: String(t.repo), detail: String(t.detail), card: null }))];
      write("chair", `### 結論\n\n${why ? `> ${why}\n\n` : ""}${String(c.conclusion).trim().replace(/^#{1,3}(?=\s)/gm, "####")}`);
    } catch (e) {
      if (e instanceof Stopped) { s.status = "waiting"; write("chair", "⏹ Owner 中止了收尾,等 Owner 發言。"); return; }
      write("chair", `⚠️ 結論沒寫成:${e.message}`);
    }
    s.status = "done"; s.queue = [];
  }

  async function round() {
    let turn = s.queue.shift();
    if (!turn) {
      now("chair");
      const r = await agent(L.chairArgv(s.chair.model, L.CHAIR_SCHEMA), { cwd: s.repo, input: L.chairPrompt(s, record()), timeout: 5 * 60000, stop: stopAsked });
      turn = L.turnFrom(s, r.structured ?? JSON.parse(r.text), lastSpeaker());
      if (turn.done) return conclude(turn.reason);
      if (turn.next === "owner") { write("chair", `→ **@Owner**:${turn.ask}${turn.reason ? `\n\n> ${turn.reason}` : ""}`); s.status = "waiting"; return; }
      write("chair", `→ **@${turn.next}**:${turn.ask}${turn.reason && !turn.yolo ? `\n\n> ${turn.reason}` : ""}${turn.yolo ? `\n\n${L.yoloLine(turn.next, turn.reason)}` : ""}`);
    }
    const m = member(turn.next);
    if (!m) return;
    now("member", m.name, turn.yolo);
    const text = record();
    const r = await agent(L.memberArgv(m, turn.yolo), { cwd: m.cwd, machine: m.machine, input: L.memberPrompt(s, m, text, turn), timeout: (turn.yolo ? 30 : 15) * 60000, stop: stopAsked });
    if (r.session) m.session = r.session;
    write(m, r.text || "(沒有回答)");
    m.seen = record().length; s.last = m.name; s.round += 1; s.failures = 0;
  }

  (async () => {
    console.log(`k-chat: 主持「${s.title}」 · ${f.md}`);
    for (;;) {
      const got = inbox();
      if (got.quit) { console.log("k-chat: Owner 關閉了主持程式"); leave(0); }
      try {
        if (got.end && s.status !== "done") await conclude("Owner 要求收尾");
        else if (s.status === "running" && !s.members.length) { write("chair", "還沒有成員:先邀請 agent 進來。"); s.status = "waiting"; }
        else if (s.status === "running" && s.round >= s.max_rounds && !s.queue.length) await conclude(`到了 ${s.max_rounds} 輪上限`);
        else if (s.status === "running") await round();
        else { now(s.status === "done" ? "done" : "waiting"); await new Promise((r) => setTimeout(r, TICK)); continue; }
      } catch (e) {
        if (e instanceof Stopped) { s.status = "waiting"; s.queue = []; write("chair", "⏹ Owner 中止了這一輪,等 Owner 發言。"); }
        else {
          s.failures = (s.failures ?? 0) + 1;
          const who = s.now?.phase === "member" ? s.now.who : "主席";
          write("chair", `⚠️ ${who} 這一輪失敗:${e.message}${s.failures >= 3 ? "\n\n連續失敗三次,先停下來等 Owner。" : ""}`);
          if (s.failures >= 3) { s.status = "waiting"; s.failures = 0; }
        }
      }
      now(s.status === "running" ? "idle" : s.status === "done" ? "done" : "waiting");
    }
  })();
}

function spawnTask(args, input, who) {
  const env = { ...childEnv(), TASK_WHO: who };
  const fake = process.env.K_CHAT_TASK;
  const r = fake
    ? spawnSync(fake, args, { input, env, encoding: "utf8" })
    : spawnSync("bash", ["-c", 'source ~/.config/tide/env && exec "$TIDE_HOME/bin/task" "$@"', "task", ...args], { input, env, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
}

// Puts a core terminal in the Herdr App's layout (the core document "herdr-app": spaces → tabs),
// as a tab of the space whose folder it is, or of a new space. False when it is already there.
function place(address, folder, tabName) {
  const rpc = (method, params) => {
    const r = spawnSync(HC, ["connect"], { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n", env: childEnv(), encoding: "utf8", timeout: 15000 });
    const res = JSON.parse((r.stdout ?? "").split("\n")[0] || "null");
    if (!res || res.error) throw new Error(`${method}: ${JSON.stringify(res?.error ?? (r.stderr || "沒有回應")).slice(0, 200)}`);
    return res.result;
  };
  const id = (prefix) => prefix + crypto.randomBytes(16).toString("hex");
  const cur = rpc("doc.get", { name: "herdr-app" });
  const value = cur.value ?? {}, spaces = [...(value.spaces ?? [])];
  if (JSON.stringify(spaces).includes(`"terminal":"${address}"`)) return false;
  let sp = spaces.find((x) => x.folder === folder);
  if (!sp) { sp = { id: id("sp"), name: path.basename(folder) || folder, folder, tabs: [] }; spaces.push(sp); }
  const tab = id("tb");
  sp.tabs = [...(sp.tabs ?? []), { id: tab, name: tabName, root: { id: tab, type: "row", children: [{ id: id("pd"), type: "block", content: { terminal: address } }] } }];
  rpc("doc.set", { name: "herdr-app", value: { ...value, spaces }, version: cur.version });
  return true;
}

function flags(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--no-yolo") o.noYolo = true;
    else if (a.startsWith("--")) { o[a.slice(2)] = argv[i + 1]; i += 1; }
    else o._.push(a);
  }
  return o;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = flags(rest);
  const statePath = o._[0] ? path.resolve(o._[0]) : null;
  const need = () => { if (!statePath) throw new Error(`用法:runner.mjs ${cmd} <state.json> …`); return L.filesOf(statePath); };
  switch (cmd) {
    case "new": {
      if (!o.repo || !o.topic) throw new Error("new 需要 --repo 與 --topic");
      const repo = path.resolve(o.repo), f = L.files(repo, o.topic);
      if (fs.existsSync(f.json)) throw new Error(`已經有這個主題:${f.json}`);
      const s = L.newState({ repo, topic: o.topic, title: o.title, space: o.space, list: JSON.parse(o.members || "[]"), chairModel: o["chair-model"], maxRounds: o["max-rounds"], allowYolo: !o.noYolo });
      fs.mkdirSync(f.inbox, { recursive: true });
      fs.writeFileSync(f.md, L.header(s));
      L.save(f.json, s);
      if (o.say) L.drop(f.inbox, { type: "say", text: o.say });
      console.log(f.json);
      break;
    }
    case "list": {
      // This repo's discussions, as JSON (the mod can't list a folder itself).
      const dir = path.join(path.resolve(o.repo || "."), "doc", "chat"), out = [];
      let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch {}
      for (const n of names) {
        try {
          const s = L.load(path.join(dir, n));
          out.push({ path: path.join(dir, n), title: s.title, status: s.status, round: s.round, max: s.max_rounds, members: s.members.map((m) => m.name) });
        } catch {}
      }
      console.log(JSON.stringify(out));
      break;
    }
    case "start": {
      // Hosts it in a herdr-core terminal of its own (it outlives this shell and the App's
      // windows), and puts that terminal in the Herdr App's layout so it can be seen and closed.
      need();
      const s = L.load(statePath);
      const live = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      if (s.runner?.pid && s.runner.host === os.hostname() && live(s.runner.pid) && Date.now() - (s.runner.at ?? 0) < 30000) { console.log(JSON.stringify({ started: false, reason: "已經有主持程式在跑", pid: s.runner.pid })); break; }
      const name = `kchat-${crypto.createHash("sha1").update(statePath).digest("hex").slice(0, 8)}`;
      const r = spawnSync(HC, ["run", "--bg", "--keep", "--no-parent", "--json", "--name", name, "--cwd", s.repo, "--", process.execPath, fileURLToPath(import.meta.url), "run", statePath], { env: childEnv(), encoding: "utf8" });
      if (r.status !== 0) throw new Error(`hc run 失敗:${(r.stderr || r.stdout || String(r.error ?? "")).trim().split("\n").pop()}`);
      let address = null; try { address = JSON.parse(r.stdout.trim().split("\n").pop()).address ?? null; } catch {}
      let placed = false, warn = null;
      try { placed = address ? place(address, s.repo, `chat: ${s.title}`.slice(0, 40)) : false; } catch (e) { warn = `沒寫進 Herdr App 排版(${e.message});terminal 還是在跑:hc attach ${name}`; }
      console.log(JSON.stringify({ started: true, terminal: name, address, in_app_layout: placed, ...(warn ? { warning: warn } : {}) }));
      break;
    }
    case "run": need(); host(statePath); break;
    case "say": L.drop(need().inbox, { type: "say", text: o._.slice(1).join(" ") }); break;
    case "invite": L.drop(need().inbox, { type: "invite", member: JSON.parse(o._[1]) }); break;
    case "set": {
      const msg = { type: "set" };
      for (const kv of o._.slice(1)) {
        const [k, v] = kv.split("=");
        if (k === "allow_yolo") msg.allow_yolo = v === "true";
        else if (k === "max_rounds") msg.max_rounds = Number(v);
        else if (k === "chair_model") msg.chair_model = v;
        else throw new Error(`不認得的設定:${k}`);
      }
      L.drop(need().inbox, msg);
      break;
    }
    case "card": L.drop(need().inbox, { type: "card", todos: String(o._[1] ?? "").split(",").filter(Boolean).map(Number) }); break;
    case "quit": L.drop(need().inbox, { type: "quit" }); break;
    default:
      console.error("用法:runner.mjs new|list|start|run|say|invite|set|card|quit …(見檔頭)");
      process.exit(2);
  }
}

try { main(); } catch (e) { console.error(`k-chat: ${e.message}`); process.exit(1); }
