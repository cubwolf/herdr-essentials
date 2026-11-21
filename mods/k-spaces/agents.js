// k-spaces (herdr-essentials): the menu behind a space row's "+": a new tab in that space, a plain
// terminal or an agent (the shipped new-menu's list: knownAgents() on the space's machine), with a
// YOLO switch that starts the agent with its skip-every-permission flag. The switch is remembered.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, knownAgents, run, closeOverlay, props, shared, setShared } from "herdr";

// The last agents each machine reported (the shipped new-menu's cache), shown while checking again.
const KNOWN = "new-menu.agents";
const YOLO_KEY = "k-spaces.yolo";

// Each agent's "don't ask me anything" flag, by its key or its program's name.
const YOLO = {
  claude: ["--dangerously-skip-permissions"],
  agy: ["--dangerously-skip-permissions"],
  antigravity: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--yolo"],
  qwen: ["--yolo"],
};
export function yoloFlags(agent) {
  const prog = String(agent?.run?.[0] ?? "").split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  return YOLO[String(agent?.key ?? "").toLowerCase()] ?? YOLO[prog] ?? null;
}

export default class AgentMenu extends View {
  init(p, cx) {
    this.spaceId = p?.space ?? null;
    this.machine = p?.machine ?? null;
    const where = this.machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.failed = false;
    this.yolo = shared(YOLO_KEY) === true;
    this.handle = cx.focus_handle();
    cx.timer.after(30, () => this.handle.focus());
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: this.machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      } catch { this.failed = true; }
      cx.notify();
    });
  }

  close() { const id = props()?.overlay; if (id) closeOverlay(id); }

  start(agent) {
    const flags = this.yolo ? yoloFlags(agent) : null;
    run("tab.new", { name: agent.name, space: this.spaceId, argv: flags ? [...agent.run, ...flags] : agent.run });
    this.close();
  }

  row(t, id, icon, name, action, hint = "", enabled = true) {
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
      .on_click(() => { if (enabled) action(); })
      .child(icon).child(div().flex_1().min_w(0).truncate().child(name)).child(div().flex_none().text_size(11).text_color(t.dim).child(hint));
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.id === this.spaceId);
    const installed = this.agents.filter((a) => a.installed);
    const choices = this.failed ? installed : [...installed, ...this.agents.filter((a) => !a.installed).slice(0, 2)];
    const toggle = () => { this.yolo = !this.yolo; setShared(YOLO_KEY, this.yolo); };
    // A popup sizes to its content: give the list room for its rows (as the shipped new-menu does).
    const rows = Math.max(1, choices.length + (this.failed || this.agents.length === 0 ? 1 : 0));
    return v_flex().id("k-agent-menu").w_full().h(Math.min(400, 108 + rows * 31)).min_h(0).bg(t.popover).p(5).text_size(12.8).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (e.key === "y") { toggle(); cx.notify(); return; }
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (agent) this.start(agent);
      })
      .child(div().px(9).pt(4).pb(4).text_size(11).text_color(t.dim).truncate().child(`New tab in ${space?.name ?? "this space"}${this.machine ? ` · ${this.machine}` : ""}`))
      .child(this.row(t, "k-agent-terminal", svg("icons/shell.svg").size(14), "Terminal", () => { run("tab.new", { space: this.spaceId }); this.close(); }))
      .child(h_flex().px(9).pt(8).pb(4).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Start an agent"))
        // YOLO: the agent asks nothing (its skip-permissions flag); Y toggles it too.
        .child(h_flex().id("k-agent-yolo").gap(6).px(6).h(22).rounded(5).items_center().cursor_pointer()
          .text_size(11).text_color(this.yolo ? t.blocked : t.dim).hover((s) => s.bg(t.hover))
          .tooltip("Start the agent without permission prompts (Y)")
          .on_click((_e, cx) => { toggle(); cx.notify(); })
          .child(div().w(26).h(14).rounded(7).p(2).flex().items_center().bg(this.yolo ? t.blocked : t.border)
            .when(this.yolo, (el) => el.justify_end())
            .child(div().size(10).rounded(5).bg("#ffffff")))
          .child("YOLO")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((a, i) => {
          const flags = yoloFlags(a);
          const hint = !a.installed ? "not installed" : this.yolo && !flags ? "no YOLO flag" : i < 9 ? String(i + 1) : "";
          return this.row(t, `k-agent-${a.key}`, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14),
            this.yolo && flags && a.installed ? `${a.name} · YOLO` : a.name, () => this.start(a), hint, a.installed);
        }))
        .when(this.failed || this.agents.length === 0, (el) => el.child(div().px(9).py(6).text_color(t.dim)
          .child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))));
  }
}
