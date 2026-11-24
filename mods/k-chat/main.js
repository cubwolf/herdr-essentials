// k-chat (herdr-essentials, ADR 0004): a group discussion among agents from several Spaces,
// chaired by an agent, hosted by the Owner. This is the window: it shows the record
// (doc/chat/<topic>.md in the main Space's repo), starts a discussion, invites agents, and
// carries what the Owner says. A discussion gets a tab of its own in the main Space ("💬 <title>",
// this mod as its pane), so its row in the sidebar brings the conversation back. The turns
// themselves are run by tools/k-chat/runner.mjs in a herdr-core terminal that isn't in the
// sidebar (`runner.mjs start --no-layout`), so closing the tab (or Herdr) doesn't stop a discussion;
// opening it again reads the same files. Everything it asks of the runner goes through the
// runner's inbox (`runner.mjs say|invite|set|card`), never into the state file.
// Open it: a Space's right-click menu → Discussion (k-spaces), or
//   herdr-app do mod.open --name k-chat      (the shown Space is the main one)
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, ScrollHandle } from "gpui-base";
import { spaces, exec, readTextFile, appHome, theme, props, closeOverlay, run, notify, checking } from "herdr";

const RUNNER = () => `${appHome().replace(/[\\/]+$/, "")}/tools/k-chat/runner.mjs`;
const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

// The record as messages (the same rule as tools/k-chat/lib.mjs and porthole's #chat).
function messages(record) {
  const out = [], text = String(record ?? "");
  const heads = [...text.matchAll(/^## (🧑 Human|🤖 Assistant)([^\n]*)$/gm)];
  heads.forEach((h, i) => {
    const rest = h[2].split("·").map((x) => x.trim()).filter(Boolean);
    const label = rest.slice(0, -1).join(" · ");
    const role = h[1].startsWith("🧑") ? "owner" : label.includes("主席") ? "chair" : "member";
    out.push({ role, who: role === "owner" ? "Owner" : role === "chair" ? "🪑 主席" : label || "Assistant", time: rest.length ? rest[rest.length - 1] : "",
      text: text.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : text.length).trim() });
  });
  return out;
}

export default class Chat extends View {
  init(_p, cx) {
    this.view = "list";       // list | new | chat
    this.topics = [];         // this repo's discussions: { path, title, status, round, members }
    this.statePath = null; this.state = null; this.record = ""; this.msgs = [];
    this.picked = new Set();  // spaces ticked in the new form / to-dos ticked for cards
    this.inviting = false; this.busy = null; this.error = null; this.yolo = true;
    this.scroll = ScrollHandle.new();
    this.topic = InputState.new({ placeholder: "主題(也是檔名),例:k-chat 要不要支援 Codex" });
    this.opening = InputState.new({ placeholder: "開場:要大家討論什麼?" });
    this.rounds = InputState.new({ placeholder: "12", value: "12" });
    this.say = InputState.new({ placeholder: "說點什麼… @成員 指定下一個發言 · /stop 中止這一輪 · /end 收尾" });
    this.say.on("submit", (_e, cx) => this.send(this.say.value(), cx));
    this.opening.on("submit", (_e, cx) => this.create(cx));
    if (checking()) return;
    // A discussion's own tab (props.state) opens on it.
    const own = props()?.state ?? _p?.state;
    if (own) this.open(own, cx);
    cx.spawn(async (cx) => { await this.loadTopics(); cx.notify(); });
    // The list is read again every few seconds (spaces arrive after init; discussions get made elsewhere).
    cx.timer.every(4000, (cx) => { if (this.view === "list" && !this.busy) cx.spawn(async (cx) => { await this.loadTopics(); cx.notify(); }); });
    cx.timer.every(1000, (cx) => { if (this.view === "chat") cx.spawn(async (cx) => { if (await this.poll() || this.state?.now?.phase !== "done") cx.notify(); }); });
  }

  // The main Space: the one the menu was opened on, else the shown one. Its folder is the repo.
  main() {
    const all = spaces();
    return all.find((s) => s.id === props()?.space) ?? all.find((s) => s.active) ?? null;
  }

  async cmd(args) {
    const r = await exec("node", [RUNNER(), ...args], { timeout: 20000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "runner 失敗").trim());
    return r.stdout.trim();
  }
  act(what, cx, job) {
    if (this.busy) return;
    this.busy = what; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try { await job(cx); } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.busy = null; cx.notify(); }
    });
  }

  // This repo's discussions, asked of the runner (a mod can't list a folder outside its own).
  async loadTopics() {
    const m = this.main();
    if (!m?.folder || m.machine) { this.topics = []; return; }
    try { this.topics = JSON.parse((await this.cmd(["list", "--repo", m.folder])) || "[]"); if (this.view === "list") this.error = null; }
    catch (e) { this.error = String(e?.message ?? e); }
  }

  // Reads the state and the record; true when something changed.
  async poll() {
    if (!this.statePath) return false;
    let changed = false;
    try {
      const text = await readTextFile(this.statePath);
      if (text && text !== this.stateText) { this.stateText = text; this.state = JSON.parse(text); changed = true; }
      const record = (await readTextFile(this.statePath.replace(/\.json$/, ".md"))) ?? "";
      if (record !== this.record) {
        this.record = record; this.msgs = messages(record); changed = true;
        this.scroll.scroll_to_item(this.msgs.length); // the row after the last message
      }
    } catch {}
    return changed;
  }

  open(path, cx) {
    this.view = "chat"; this.statePath = path; this.state = null; this.stateText = null; this.record = ""; this.msgs = [];
    this.picked = new Set(); this.inviting = false; this.error = null;
    cx.spawn(async (cx) => { await this.poll(); cx.notify(); });
    cx.notify();
  }

  // The runner writes its pid and the time every few seconds while it hosts.
  hosted() { return Boolean(this.state?.runner) && Date.now() - (this.state.runner.at ?? 0) < 20000; }
  // Starts the runner in a herdr-core terminal of its own, out of the sidebar: the discussion's
  // tab is this view, not the runner's log. (`hc attach kchat-…` shows the log.)
  async host() {
    if (!this.statePath) return;
    const out = JSON.parse((await this.cmd(["start", this.statePath, "--no-layout"])) || "{}");
    if (out.warning) this.error = out.warning;
  }

  // A discussion lives in a tab of the main Space ("💬 <title>", this mod as its only pane):
  // the sidebar's row for it brings the conversation back. Shown if it is there, made if not.
  pin(path, title) {
    const m = this.main();
    if (!m) return false;
    const name = `💬 ${title}`.slice(0, 40);
    const tab = m.tabs.find((x) => x.name === name);
    if (tab) run("tab.select", { id: tab.id });
    else run("tab.new", { space: m.id, name, mod: "k-chat", props: { state: path, space: m.id } });
    return true;
  }
  // From the window (an overlay), a discussion opens in its tab and the window closes; in a tab, in place.
  go(path, title, cx) {
    const overlay = props()?.overlay;
    if (overlay && this.pin(path, title)) { closeOverlay(overlay); return; }
    this.open(path, cx);
  }

  create(cx) {
    const m = this.main(), topic = this.topic.value().trim(), opening = this.opening.value().trim();
    if (!m) { this.error = "沒有 Space:先開一個 Space 當主 Space。"; cx.notify(); return; }
    if (m.machine) { this.error = `主 Space 要在這台機器上(${m.name} 在 ${m.machine});成員可以在別台。`; cx.notify(); return; }
    if (!topic || !opening) { this.error = "主題和開場都要填。"; cx.notify(); return; }
    const list = spaces().filter((s) => this.picked.has(s.id)).map((s) => ({ name: s.name, space: s.name, machine: s.machine, cwd: s.folder }));
    if (!list.length) { this.error = "至少邀一個 agent。"; cx.notify(); return; }
    this.act("建立討論…", cx, async (cx) => {
      const path = await this.cmd(["new", "--repo", m.folder, "--topic", topic, "--title", topic, "--space", m.name, "--members", JSON.stringify(list), "--say", opening,
        "--max-rounds", String(Number(this.rounds.value()) > 0 ? Number(this.rounds.value()) : 12), ...(this.yolo ? [] : ["--no-yolo"])]);
      this.topic.set_value(""); this.opening.set_value("");
      this.statePath = path;
      await this.host();
      this.go(path, topic, cx);
    });
  }

  send(text, cx) {
    const t = String(text ?? "").trim();
    if (!t || !this.statePath) return;
    this.say.set_value("");
    this.act("送出…", cx, async () => {
      await this.cmd(["say", this.statePath, t]);
      if (!this.hosted()) await this.host(); // nobody is hosting: start it again
    });
  }

  render(_cx) {
    const t = theme(), p = props() ?? {}, m = this.main(), s = this.state;
    const button = (id, text, action, o = {}) => h_flex().id(id).h(26).px(10).items_center().rounded(7).flex_none()
      .border_1().border_color(o.primary ? t.solid : o.on ? t.accent : t.input).bg(o.primary ? t.solid : t.raised)
      .text_color(o.primary ? t.solid_foreground : o.on ? t.accent : t.foreground).text_size(12)
      .when(Boolean(o.off), (el) => el.opacity(0.45))
      .when(!o.off, (el) => el.cursor_pointer().hover((st) => st.opacity(0.85))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action))
      .when(Boolean(o.tip), (el) => el.tooltip(o.tip)).child(text);
    const field = (state) => Input.new(state).h(30).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    const tick = (id, on, label, hint, toggle) => h_flex().id(id).min_h(30).px(8).gap(9).items_center().rounded(7).cursor_pointer().hover((st) => st.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(toggle)
      .child(div().size(15).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
        .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground ?? "#fff").child(on ? "✓" : ""))
      .child(div().flex_none().child(label))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(hint ?? ""));

    const top = (title, ...right) => h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(this.view !== "list", (el) => el.child(div().id("k-chat-back").w(20).cursor_pointer().text_color(t.muted)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.view = "list"; this.error = null; cx.spawn(async (cx) => { await this.loadTopics(); cx.notify(); }); cx.notify(); }).child("←")))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
      .children(right)
      .when(Boolean(p.overlay), (el) => el.child(div().id("k-chat-close").size(22).flex().items_center().justify_center().rounded(5).text_color(t.dim).cursor_pointer()
        .hover((st) => st.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => closeOverlay(p.overlay)).child("✕")));
    const note = () => div().px(14).py(6).text_size(12).text_color(this.error ? t.blocked : t.dim).child(this.error ?? this.busy ?? "");
    const shell = (...kids) => v_flex().id("k-chat").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.popover ?? t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).children(kids);

    if (this.view === "list") {
      return shell(
        top(`Discussions · ${m?.name ?? "(no space)"}`, button("k-chat-new", "New discussion", (_e, cx) => { this.view = "new"; this.picked = new Set(); this.error = null; cx.notify(); }, { primary: true })),
        v_flex().id("k-chat-topics").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(2)
          .when(!this.topics.length, (el) => el.child(div().p(10).text_size(12).text_color(t.dim)
            .child(m ? `${m.name} 的 doc/chat/ 還沒有討論。按 New discussion 開一場:邀幾個 Space 的 agent 進來,主席輪流點名。` : "先開一個 Space。")))
          .children(this.topics.map((x, i) => h_flex().id(`k-chat-topic-${i}`).min_h(40).px(10).gap(10).items_center().rounded(7).cursor_pointer().hover((st) => st.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.go(x.path, x.title, cx))
            .child(div().size(8).flex_none().rounded_full().bg(x.status === "running" ? t.working : x.status === "waiting" ? t.blocked : t.done))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().child(x.title))
              .child(div().truncate().text_size(11).text_color(t.dim).child(x.members.join("、"))))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(`${x.status === "done" ? "已結束" : x.status === "waiting" ? "等 Owner" : "進行中"} · ${x.round}/${x.max} 輪`)))),
        note());
    }

    if (this.view === "new") {
      const all = spaces();
      return shell(
        top("New discussion", button("k-chat-create", "Start", (_e, cx) => this.create(cx), { primary: true, off: Boolean(this.busy) })),
        v_flex().id("k-chat-form").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(10)
          .child(div().text_size(11.5).text_color(t.dim).child(`主 Space:${m?.name ?? "?"} · 紀錄存到 ${m?.folder ?? "?"}/doc/chat/`))
          .child(field(this.topic))
          .child(field(this.opening))
          .child(h_flex().gap(10).items_center()
            .child(div().text_size(12).text_color(t.muted).child("輪數上限"))
            .child(field(this.rounds).w(70))
            .child(button("k-chat-yolo-new", this.yolo ? "允許主席開 YOLO:開" : "允許主席開 YOLO:關", (_e, cx) => { this.yolo = !this.yolo; cx.notify(); },
              { on: this.yolo, tip: "開:主席可以讓某個成員某一輪動手改檔(紀錄裡會有 🔓 一行),那輪結束就收回" })))
          .child(div().pt(6).text_size(11).font_semibold().text_color(t.muted).child(`邀請(${this.picked.size})`))
          .children(all.map((sp, i) => tick(`k-chat-pick-${i}`, this.picked.has(sp.id), sp.name, `${sp.machine ? `${sp.machine} · ` : ""}${sp.folder}`,
            (_e, cx) => { if (this.picked.has(sp.id)) this.picked.delete(sp.id); else this.picked.add(sp.id); cx.notify(); }))),
        note());
    }

    // The discussion.
    const names = s?.members?.map((x) => x.name) ?? [];
    const tint = (who) => { const i = names.findIndex((n) => who.startsWith(`${n}@`)); return [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6][Math.max(0, i) % 5]; };
    const hosted = this.hosted(), now = s?.now ?? {};
    const secs = Math.max(0, Math.round((Date.now() - (now.since ?? Date.now())) / 1000));
    const status = !s ? "讀取中…"
      : !hosted ? "主持程式沒在跑"
        : now.phase === "member" ? `${now.who} 發言中${now.yolo ? " 🔓 YOLO" : ""} · ${secs}s`
          : now.phase === "chair" ? `主席在想誰發言 · ${secs}s`
            : now.phase === "conclude" ? `主席在寫結論 · ${secs}s`
              : s.status === "done" ? "已結束(再發言會重新開始)" : s.status === "waiting" ? "等 Owner 發言" : "…";
    const active = hosted && ["member", "chair", "conclude"].includes(now.phase);
    const todos = s?.todos ?? [], open = todos.map((x, i) => [x, i]).filter(([x]) => !x.card);
    const others = spaces().filter((sp) => !(s?.members ?? []).some((x) => x.cwd === sp.folder && (x.machine ?? null) === (sp.machine ?? null)));

    return shell(
      top(s?.title ?? "…",
        div().flex_none().text_size(11).text_color(t.dim).child(s ? `${s.round}/${s.max_rounds} 輪` : ""),
        button("k-chat-yolo", s?.allow_yolo ? "YOLO 可開" : "YOLO 關", (_e, cx) => this.act("設定…", cx, () => this.cmd(["set", this.statePath, `allow_yolo=${!s?.allow_yolo}`])),
          { on: Boolean(s?.allow_yolo), off: !s, tip: "允許主席讓某個成員某一輪動手改檔" }),
        button("k-chat-invite", "Invite", (_e, cx) => { this.inviting = !this.inviting; cx.notify(); }, { on: this.inviting, off: !s }),
        button("k-chat-stop", "Stop", (_e, cx) => this.send("/stop", cx), { off: !active, tip: "中止現在這一輪(/stop)" }),
        button("k-chat-end", "Wrap up", (_e, cx) => this.send("/end", cx), { off: !s || s.status === "done", tip: "請主席現在寫結論(/end)" })),
      h_flex().h(28).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5)
        .child(div().size(8).flex_none().rounded_full().bg(!hosted ? t.blocked : active ? t.working : s?.status === "done" ? t.done : t.idle ?? t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(status))
        .child(div().flex_none().truncate().text_color(t.dim).child(names.join("、")))
        .when(Boolean(s) && !hosted, (el) => el.child(button("k-chat-host", "Resume", (_e, cx) => this.act("啟動主持程式…", cx, () => this.host()), { primary: true, tip: "在背景接著主持(herdr-core 裡的 terminal,不佔側欄)" })))
        .when(Boolean(s) && hosted && !active, (el) => el.child(button("k-chat-quit", "Stop host", (_e, cx) => this.act("關閉主持程式…", cx, () => this.cmd(["quit", this.statePath])), { tip: "讓背景的主持程式離開;紀錄留著,之後發言或按 Resume 會再起來" }))),
      this.inviting ? v_flex().flex_none().max_h(220).overflow_y_scrollbar().p(8).border_b(1).border_color(t.border)
        .when(!others.length, (el) => el.child(div().p(6).text_size(12).text_color(t.dim).child("所有 Space 都已經在討論裡。")))
        .children(others.map((sp, i) => tick(`k-chat-inv-${i}`, false, sp.name, `${sp.machine ? `${sp.machine} · ` : ""}${sp.folder}`,
          (_e, cx) => { this.inviting = false; this.act("邀請…", cx, () => this.cmd(["invite", this.statePath, JSON.stringify({ name: sp.name, space: sp.name, machine: sp.machine, cwd: sp.folder })])); }))) : div(),
      v_flex().id("k-chat-record").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(12).gap(10)
        .children(this.msgs.map((x, i) => v_flex().flex_none().gap(3).px(11).py(8).rounded(9)
          .bg(x.role === "owner" ? `${t.accent}1f` : x.role === "chair" ? `${t.background}00` : t.raised ?? t.hover)
          .when(x.role === "chair", (el) => el.border_1().border_color(t.border))
          .child(h_flex().gap(8).items_center().text_size(11)
            .child(div().font_semibold().text_color(x.role === "owner" ? t.accent : x.role === "chair" ? t.muted : tint(x.who)).child(x.who))
            .child(div().text_color(t.dim).child(x.time))
            .when(x.text.includes("🔓"), (el) => el.child(div().px(5).rounded(4).bg(`${t.blocked}33`).text_color(t.blocked).child("YOLO"))))
          .child(div().text_size(x.role === "chair" ? 12.5 : 13.5).line_height(1.5).when(x.role === "chair", (el) => el.text_color(t.muted))
            .child(TextView.markdown(`k-chat-msg-${i}`, x.text).selectable(true)))))
        .child(div().flex_none().h(18).px(4).text_size(11.5).text_color(t.dim).child(active ? `${status}…` : "")),
      open.length || todos.some((x) => x.card) ? v_flex().flex_none().max_h(200).overflow_y_scrollbar().px(8).py(6).border_t(1).border_color(t.border)
        .child(h_flex().px(8).pb(2).gap(8).items_center()
          .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("結論的待辦"))
          .child(button("k-chat-cards", `開成 Tide 卡(${this.picked.size})`, (_e, cx) => {
            const list = [...this.picked].join(","); this.picked = new Set();
            this.act("開卡…", cx, () => this.cmd(["card", this.statePath, list]));
          }, { primary: true, off: !this.picked.size || !hosted, tip: hosted ? "勾選的才開;不勾就不開" : "先按 Resume 讓主持程式跑起來" })))
        .children(todos.map((x, i) => x.card
          ? h_flex().min_h(26).px(8).gap(9).items_center().text_size(12).child(div().flex_none().text_color(t.done).child(`#${x.card}`)).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${x.title} · ${x.repo}`))
          : tick(`k-chat-todo-${i}`, this.picked.has(i), x.title, x.repo, (_e, cx) => { if (this.picked.has(i)) this.picked.delete(i); else this.picked.add(i); cx.notify(); }))) : div(),
      h_flex().flex_none().p(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(field(this.say).flex_1())
        .child(button("k-chat-send", "Send", (_e, cx) => this.send(this.say.value(), cx), { primary: true, off: !s })),
      this.error || this.busy ? note() : div());
  }
}
