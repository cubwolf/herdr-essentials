// k-pick (herdr-essentials): point at a part of the window for an agent, like the web DevPick
// (Ctrl+F12 there). Herdr draws natively, so there's no DOM to ask: a transparent layer over the
// whole window works out which layout block is under the pointer from layout() (rows, columns,
// px / weight sizes, hidden, stacks), outlines it, and on a click copies a locator such as
//   layout=k-main | block=sidebar-footer | mod=k-chrome | file=mods/k-chrome/main.js | path=root > sidebar > sidebar-footer | at=(52,1430) in block (44,12) of 268×69 | shot=…png
// with a window shot (outline and click mark in it) for the agent to look at. Esc leaves.
// Open it: herdr-app do mod.open --name k-pick. Blocks only for now: dialogs and floats aren't in
// layout(), so a pick over one reports the block underneath.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, shared, props, closeOverlay, exec, appHome, notify, window } from "herdr";

const sep = () => (window()?.platform === "windows" ? "\\" : "/");

// Every block's rectangle in logical px, parents before children; `depth` for the innermost pick.
function rects(node, x, y, w, h, out = [], depth = 0, path = []) {
  if (!node || node.hidden) return out;
  const here = [...path, node.id ?? node.type];
  out.push({ id: node.id, type: node.type, mod: node.content?.mod, terminal: node.content?.terminal, x, y, w, h, depth, path: here });
  const kids = (node.children ?? []).filter((c) => c && !c.hidden);
  if (node.type === "stack") {
    const shown = kids.find((c) => c.id === node.active) ?? kids[0];
    if (shown) rects(shown, x, y, w, h, out, depth + 1, here);
    return out;
  }
  if (node.type !== "row" && node.type !== "column") return out;
  const across = node.type === "row";
  const pad = typeof node.padding === "number" ? node.padding : 0;
  x += pad; y += pad; w -= 2 * pad; h -= 2 * pad;
  const between = (node.gap ?? 0) + (node.divider?.width ?? 0);
  const total = (across ? w : h) - between * Math.max(0, kids.length - 1);
  const clamp = (c, v) => Math.max(c.min ?? 0, Math.min(c.max ?? Infinity, v));
  const fixed = kids.map((c) => (c.size?.px != null ? clamp(c, c.size.px) : null));
  const left = Math.max(0, total - fixed.reduce((a, v) => a + (v ?? 0), 0));
  const weights = kids.map((c, i) => (fixed[i] != null ? 0 : c.size?.weight ?? 1));
  const sum = weights.reduce((a, v) => a + v, 0) || 1;
  let at = across ? x : y;
  kids.forEach((c, i) => {
    const len = fixed[i] ?? (left * weights[i]) / sum;
    if (across) rects(c, at, y, len, h, out, depth + 1, here);
    else rects(c, x, at, w, len, out, depth + 1, here);
    at += len + between;
  });
  return out;
}

// The innermost block under a point.
function hit(list, px, py) {
  let best = null;
  for (const r of list) if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h && (!best || r.depth >= best.depth)) best = r;
  return best;
}

const what = (r) => (r.mod ? `mod=${r.mod}` : r.terminal ? `terminal=${r.terminal}` : r.type === "block" ? "terminal panes (Herdr)" : `type=${r.type}`);

export default class Pick extends View {
  init(p, cx) {
    this.size = null;
    this.pointer = null;
    this.picked = null;
    this.handle = cx.focus_handle();
    cx.timer.after(50, () => this.handle.focus());
  }

  blocks() {
    const s = this.size;
    return s ? rects(layout(), 0, 0, s.width, s.height) : [];
  }

  pick(e, cx) {
    if (this.picked) return;
    const { x, y } = e.position;
    const r = hit(this.blocks(), x, y);
    if (!r) return;
    this.picked = { r, x, y };
    cx.notify();
    const loc = [
      `layout=${shared("layout") ?? "?"}`,
      `block=${r.id ?? "?"}`,
      what(r),
      r.mod && `file=mods/${r.mod}/main.js`,
      `path=${r.path.join(" > ")}`,
      `at=(${Math.round(x)},${Math.round(y)}) in block (${Math.round(x - r.x)},${Math.round(y - r.y)}) of ${Math.round(r.w)}×${Math.round(r.h)}`,
    ].filter(Boolean).join("  |  ");
    // Let the outline and mark draw, shoot the window with them, then copy and leave.
    cx.timer.after(150, (cx) => cx.spawn(async (cx) => {
      const dir = `${appHome()}${sep()}.k-pick`;
      // Local time in the name (pick-20261121-004340.png), to match the clock people see.
      const d = new Date(), two = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
      const shot = `${dir}${sep()}pick-${stamp}.png`;
      let text = loc;
      try {
        // herdr-app shot doesn't make the folder.
        if (window()?.platform === "windows") await exec("powershell.exe", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null`]);
        else await exec("mkdir", ["-p", dir]);
        const res = await exec("herdr-app", ["shot", shot]);
        if (res.code === 0) text += `  |  shot=${shot}`;
      } catch {}
      cx.write_to_clipboard(text);
      notify({ title: "k-pick: copied", body: text, level: "success", timeout: 6000 });
      closeOverlay(props()?.overlay);
    }));
  }

  render(_cx) {
    const t = theme();
    const list = this.blocks();
    const at = this.picked ?? (this.pointer && { x: this.pointer.x, y: this.pointer.y, r: hit(list, this.pointer.x, this.pointer.y) });
    const r = at?.r;
    const accent = this.picked ? t.done : t.accent;
    return div().id("k-pick").size_full().relative().cursor_crosshair()
      .track_focus(this.handle)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_move((e, cx) => { if (!this.picked) { this.pointer = e.position; cx.notify(); } })
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pick(e, cx); })
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props()?.overlay); } })
      .when(Boolean(r), (el) => el.child(div().absolute().left(r.x).top(r.y).w(r.w).h(r.h).border_2().border_color(accent).bg(`${accent}22`)))
      .when(Boolean(r), (el) => el.child(div().absolute().left(r.x + 4).top(Math.max(0, r.y + 4)).px(6).py(2).rounded(4).bg(accent).text_color(t.solid_foreground ?? "#ffffff").text_size(11.5)
        .child(`${r.id ?? "?"} · ${what(r)}`)))
      .when(Boolean(this.picked), (el) => el.child(div().absolute().left(this.picked.x - 6).top(this.picked.y - 6).size(12).rounded_full().border_2().border_color("#ff3b30").bg("#ff3b3055")))
      .child(h_flex().absolute().top(0).left(0).right(0).h(26).justify_center().items_center().bg(`${t.accent}e6`).text_color(t.solid_foreground ?? "#ffffff").text_size(12)
        .child(this.picked ? "k-pick · 已複製定位器" : "k-pick · 點一個區塊複製定位器 · Esc 退出"));
  }
}
