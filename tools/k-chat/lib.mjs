// k-chat (herdr-essentials, ADR 0004): the parts of the discussion runner that don't start
// programs: the record's format, what the Owner's messages mean, the prompts, the arguments
// each member's agent is started with. runner.mjs does the turns.
import fs from "node:fs";
import path from "node:path";

export const READ_TOOLS = "Read,Grep,Glob,WebFetch,WebSearch";
export const TAIL = 60000; // characters of the record a prompt carries at most

const two = (n) => String(n).padStart(2, "0");
export const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}`;
export const day = (d = new Date()) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

// A topic as a file name: no separators, no leading dot.
export function slug(topic) {
  const s = String(topic ?? "").trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^[-.]+|-+$/g, "");
  if (!s) throw new Error("主題不能是空的");
  return s.slice(0, 80);
}

// Where one discussion's files are: the record, its state, the Owner's inbox.
export function files(repo, topic) {
  const base = path.join(repo, "doc", "chat", slug(topic));
  return { md: `${base}.md`, json: `${base}.json`, inbox: `${base}.inbox` };
}
export const filesOf = (statePath) => {
  const base = statePath.replace(/\.json$/, "");
  return { md: `${base}.md`, json: statePath, inbox: `${base}.inbox` };
};

// Members as given ({ name?, space, machine?, cwd, agent?, fork? }) with unique names.
export function members(list, taken = []) {
  const used = new Set(taken);
  return (list ?? []).map((m) => {
    if (!m?.cwd) throw new Error(`成員 ${m?.name ?? m?.space ?? "?"} 沒有資料夾(cwd)`);
    let name = String(m.name || m.space || path.basename(m.cwd)).replace(/[\s@]+/g, "-");
    if (used.has(name) && m.machine) name = `${name}-${m.machine}`;
    for (let i = 2, base = name; used.has(name); i += 1) name = `${base}-${i}`;
    used.add(name);
    return { name, space: m.space || name, machine: m.machine || null, cwd: m.cwd, agent: m.agent === "codex" ? "codex" : "claude", session: null, fork: m.fork || null, seen: 0 };
  });
}

export function newState({ repo, topic, title, space, list, chairModel, maxRounds, allowYolo }) {
  return {
    k_chat: 1, topic: slug(topic), title: title || topic, repo, space: space || path.basename(repo),
    chair: { model: chairModel || "sonnet" }, allow_yolo: allowYolo !== false, max_rounds: Number(maxRounds) > 0 ? Number(maxRounds) : 12,
    round: 0, status: "running", now: { phase: "idle", who: null, since: Date.now() },
    members: members(list), queue: [], todos: [], failures: 0, runner: null,
  };
}

// The record. Headings are the chat plugin's (porthole's #chat reads "## 🧑 Human" and
// "## 🤖 Assistant"); who spoke comes after the role.
export const header = (s, d = new Date()) =>
  `# Chat: ${s.title}\n\n> k-chat 討論群 · 開始於 ${day(d)} ${clock(d)} · 主席 ${s.chair.model} · 成員:${s.members.map((m) => `${m.name}@${m.space}`).join("、") || "(還沒有)"}\n`;
export const entry = (who, text, d = new Date()) => {
  const head = who === "owner" ? "🧑 Human" : who === "chair" ? "🤖 Assistant · 🪑 主席" : `🤖 Assistant · ${who.name}@${who.space}`;
  // What someone said can't start a new message: its own # and ## headings go down to ###.
  return `\n## ${head} · ${clock(d)}\n\n${String(text).trim().replace(/^#{1,2}(?=\s)/gm, "###")}\n`;
};
export const yoloLine = (name, reason) => `🔓 主席授權 ${name} YOLO:${String(reason || "要動手實作").replace(/\s+/g, " ").trim()}`;

// The record as messages, for the mod: [{ role: "owner" | "chair" | "member", who, time, text }].
export function messages(record) {
  const out = [];
  const re = /^## (🧑 Human|🤖 Assistant)([^\n]*)$/gm;
  const heads = [...String(record ?? "").matchAll(re)];
  heads.forEach((h, i) => {
    const rest = h[2].split("·").map((x) => x.trim()).filter(Boolean);
    const time = rest.length ? rest[rest.length - 1] : "";
    const label = rest.slice(0, -1).join(" · ");
    const role = h[1].startsWith("🧑") ? "owner" : label.includes("主席") ? "chair" : "member";
    const end = i + 1 < heads.length ? heads[i + 1].index : record.length;
    out.push({ role, who: role === "owner" ? "Owner" : role === "chair" ? "主席" : label || "Assistant", time, text: record.slice(h.index + h[0].length, end).trim() });
  });
  return out;
}

// What an Owner message asks of the runner, besides being said.
//   /stop: end the turn that is running and wait.  /end: have the chair conclude now.
//   @name: that member speaks next (in the order named).
export function parseSay(text, names) {
  const t = String(text ?? "").trim();
  const cmd = /^\/(stop|end)(?![\w-])/i.exec(t)?.[1]?.toLowerCase() ?? null;
  const mentions = [];
  for (const m of t.matchAll(/@([^\s@,,。:：、;;!!??]+)/g)) if (names.includes(m[1]) && !mentions.includes(m[1])) mentions.push(m[1]);
  return { text: t, stop: cmd === "stop", end: cmd === "end", mentions };
}

const tail = (text) => (text.length > TAIL ? `…(前面省略 ${text.length - TAIL} 字)\n${text.slice(-TAIL)}` : text);
const roster = (s) => s.members.map((m) => `- ${m.name}:Space「${m.space}」,${m.machine ? `機器 ${m.machine}` : "本機"},資料夾 ${m.cwd}(${m.agent === "codex" ? "Codex" : "Claude Code"})`).join("\n");

export const CHAIR_SCHEMA = {
  type: "object",
  properties: {
    next: { type: "string", description: "下一個發言的成員名字;要等 Owner 回話就填 owner" },
    ask: { type: "string", description: "要問他什麼,或要他做什麼" },
    yolo: { type: "boolean", description: "這一輪讓他動手改檔 / 跑指令" },
    done: { type: "boolean", description: "討論可以結束了" },
    reason: { type: "string", description: "一句話:為什麼是他、為什麼開 YOLO、或為什麼結束" },
  },
  required: ["next", "ask", "yolo", "done", "reason"],
};
export const CONCLUDE_SCHEMA = {
  type: "object",
  properties: {
    conclusion: { type: "string", description: "Markdown:決定、還沒談定的、待辦與負責人" },
    todos: { type: "array", items: { type: "object", properties: {
      title: { type: "string" }, repo: { type: "string", description: "負責的成員的 Space / repo 名" }, detail: { type: "string" } },
      required: ["title", "repo", "detail"] } },
  },
  required: ["conclusion", "todos"],
};

export function chairPrompt(s, record) {
  return `你是「${s.title}」這場多 agent 討論的主席。Owner(人)主持,你決定每一輪誰發言。你自己不發表意見。

成員:
${roster(s)}

規則:
- 一次只點一個人。挑最能推進討論的:被問到的、有那個 repo 的知識的、還沒表態的。不要讓同一個人連講三輪。
- Owner 的話優先:他剛說了什麼,下一輪就先處理那件事。
- 需要 Owner 決定或補資料時,next 填 "owner",ask 寫要他回答什麼,然後等他。
- 成員預設只能讀(讀檔、搜尋、查網頁)。${s.allow_yolo
    ? "只有在大家已經談定要動手、而且動手的範圍講清楚了,才把 yolo 設成 true:那個成員這一輪可以改檔、跑指令(在他自己的資料夾裡),下一輪就收回。reason 要寫清楚授權的理由。拿不準就不要開。"
    : "Owner 關掉了 YOLO:yolo 一律 false。"}
- 該談的談完了、或大家開始重複,就 done: true。
- 現在是第 ${s.round + 1} 輪,上限 ${s.max_rounds} 輪。

目前的對話紀錄:
<record>
${tail(record)}
</record>

輸出下一輪的安排。`;
}

export function concludePrompt(s, record) {
  return `你是「${s.title}」這場多 agent 討論的主席。討論結束了,請寫結論。

成員:
${roster(s)}

對話紀錄:
<record>
${tail(record)}
</record>

conclusion 用繁體中文 Markdown,依序三段:「決定」(談定了什麼)、「還沒談定」(沒有就寫無)、「待辦」(每項誰負責)。只寫紀錄裡有的,不要補充沒人說過的事。
todos 把待辦逐項列出:title 一句話,repo 填負責的成員的 Space 名,detail 寫要做什麼、做到什麼算完成。沒有待辦就給空陣列。`;
}

// What a member is told: the rules once, then what was said since it last spoke, then the ask.
export function memberPrompt(s, m, record, turn) {
  const first = !m.session;
  const since = record.slice(Math.min(m.seen ?? 0, record.length));
  const intro = `你被邀請進一場多 agent 討論「${s.title}」,你的名字是 ${m.name}(Space「${m.space}」,你在自己的資料夾 ${m.cwd} 裡)。Owner(人)主持,主席決定誰發言。

成員:
${roster(s)}

怎麼參與:
- 輪到你才發言。你的回答會原樣貼進對話紀錄給所有人看,所以直接講內容,不要寒暄、不要重述問題。
- 用繁體中文,簡短:先講結論,再講依據。需要的話先讀你資料夾裡的檔案再回答,引用時寫出檔案路徑。
- 不知道就說不知道;該別的成員回答的事,點名他。
- 預設你只能讀。主席明說這一輪授權你動手(YOLO)時,才改檔或跑指令,做完回報改了什麼。
`;
  return `${first ? `${intro}\n` : ""}${first ? "到目前為止的對話紀錄" : "你上次發言之後的對話紀錄"}:
<record>
${tail(since) || "(沒有新的)"}
</record>

${turn.from === "owner" ? "Owner 點名你回答上面他說的話。" : `主席問你:${turn.ask}`}
${turn.yolo ? "\n主席授權你這一輪動手(YOLO):可以改檔、跑指令,只做被要求的範圍,做完回報改了哪些檔。" : "\n這一輪只能讀,不要嘗試改檔或跑指令。"}`;
}

// The agent's arguments for one turn. Read-only by default; YOLO for that turn only.
export function memberArgv(m, yolo) {
  if (m.agent === "codex") {
    const mode = yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "read-only"];
    return { bin: "codex", args: m.session ? ["exec", "resume", m.session, "--json", ...mode, "-"] : ["exec", "--json", ...mode, "-"] };
  }
  const args = ["-p", "--output-format", "json"];
  if (m.session) args.push("--resume", m.session);
  else if (m.fork) args.push("--resume", m.fork, "--fork-session");
  if (yolo) args.push("--dangerously-skip-permissions");
  else args.push("--tools", READ_TOOLS, "--allowedTools", READ_TOOLS, "--strict-mcp-config");
  return { bin: "claude", args };
}
export const chairArgv = (model, schema) =>
  ({ bin: "claude", args: ["-p", "--output-format", "json", "--model", model, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--json-schema", JSON.stringify(schema)] });

// What the agent printed, as { text, session, structured }.
export function parseReply(agent, stdout) {
  const out = String(stdout ?? "").trim();
  if (agent === "codex") {
    let text = "", session = null;
    for (const line of out.split("\n")) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "thread.started" && e.thread_id) session = e.thread_id;
      if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) text = e.item.text;
    }
    if (!text) throw new Error(`Codex 沒有回答:${out.slice(-300)}`);
    return { text, session, structured: null };
  }
  // Something may be printed before the JSON (a shell banner on another machine): take the last JSON line.
  const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{")) ?? out;
  let r; try { r = JSON.parse(line); } catch { throw new Error(`讀不懂 agent 的輸出:${out.slice(-300) || "(空的)"}`); }
  if (r.is_error) throw new Error(String(r.result || r.subtype || "agent 回報錯誤").slice(0, 500));
  return { text: String(r.result ?? ""), session: r.session_id ?? null, structured: r.structured_output ?? null };
}

// The chair's answer made safe: a member that exists, YOLO only when allowed.
export function turnFrom(s, c, last) {
  const names = s.members.map((m) => m.name);
  const done = Boolean(c?.done);
  let next = String(c?.next ?? "").replace(/^@/, "").trim();
  if (!done && next.toLowerCase() !== "owner" && !names.includes(next)) {
    // Not a member: whoever follows the last speaker.
    next = names[(names.indexOf(last) + 1) % names.length] ?? "owner";
  }
  return { next: next.toLowerCase() === "owner" ? "owner" : next, ask: String(c?.ask ?? "").trim(), yolo: Boolean(c?.yolo) && s.allow_yolo && !done,
    done, reason: String(c?.reason ?? "").trim(), from: "chair" };
}

// State is written whole, by the runner only (everyone else writes to the inbox).
export function save(statePath, s) {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, statePath);
}
export const load = (statePath) => {
  const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (s?.k_chat !== 1) throw new Error(`${statePath} 不是 k-chat 的討論`);
  return s;
};

// The inbox: one small JSON file per message, taken in name order.
export function drop(inbox, msg) {
  fs.mkdirSync(inbox, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(inbox, `.${name}`), JSON.stringify(msg));
  fs.renameSync(path.join(inbox, `.${name}`), path.join(inbox, name));
  return name;
}
export function peek(inbox) {
  let names = [];
  try { names = fs.readdirSync(inbox).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort(); } catch {}
  const out = [];
  for (const name of names) {
    try { out.push({ name, msg: JSON.parse(fs.readFileSync(path.join(inbox, name), "utf8")) }); } catch { out.push({ name, msg: null }); }
  }
  return out;
}
export function take(inbox) {
  const out = [];
  for (const g of peek(inbox)) {
    const file = path.join(inbox, g.name);
    // Unreadable: still being written (the mod's write isn't a rename). Left for the next look,
    // thrown away once it is clearly not going to become JSON.
    if (!g.msg) { try { if (Date.now() - fs.statSync(file).mtimeMs < 5000) break; } catch {} }
    try { fs.unlinkSync(file); } catch {}
    if (g.msg) out.push(g.msg);
  }
  return out;
}
