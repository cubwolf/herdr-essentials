// k-spaces (herdr-essentials): the menu behind a machine's "+". Lists the GitHub repos that
// machine's `gh` can see (yours, your orgs', collaborations), marks the ones already cloned there,
// and opens a space in a clone, cloning it first into that machine's default folder when needed.
// "New empty space" is the plain space.new it replaced.
//
// Everything runs on the chosen machine (exec `on`), so its gh login and folders are the ones used.
// Kept per machine in shared("k-spaces.repos"): { base: default clone folder, clones: { "owner/name": path } }.
// A clone is also found by looking two levels under `base` for .git folders and their origin.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, spaces, shared, setShared, theme, props, closeOverlay, notify, window } from "herdr";

const KEY = "k-spaces.repos";
const store = () => { const s = shared(KEY); return s && typeof s === "object" && !Array.isArray(s) ? s : {}; };
const saveFor = (mk, patch) => { const s = store(); setShared(KEY, { ...s, [mk]: { ...(s[mk] ?? {}), ...patch } }); };

// "owner/name" from a GitHub remote (https or ssh), lower-cased; null for anything else.
function slugOf(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
const sameDir = (a, b) => String(a ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === String(b ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
const ago = (iso) => {
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  return !isFinite(d) ? "" : d < 1 ? "today" : d < 30 ? `${Math.floor(d)}d` : d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
};

export default class RepoMenu extends View {
  init(p, cx) {
    this.machine = p?.machine ?? null;               // null: this computer
    this.mk = this.machine ?? "";                    // its key in the store
    this.on = this.machine ? { on: this.machine } : {};
    this.sys = null;                                 // { posix, home, sep } of that machine
    this.repos = null;                               // [{ slug, full, name, private, pushed }]
    this.found = {};                                 // slug -> clone path seen under base
    this.error = null;
    this.query = "";
    this.picked = null;                              // a repo waiting for "Clone"
    this.busy = null;
    this.search = InputState.new({ placeholder: "Search repos" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { const first = this.list()[0]; if (first) this.choose(first, cx); });
    this.baseInput = InputState.new({ placeholder: "Folder to clone into" });
    this.baseInput.on("submit", (_e, cx) => this.clone(cx));
    cx.timer.after(60, () => this.search.focus());
    cx.spawn(async (cx) => this.load(cx));
  }

  async run(cmd, args, timeout) {
    return exec(cmd, args, { ...this.on, ...(timeout ? { timeout } : {}) });
  }

  // Which shell that machine has, and its home: a remote one may be Windows too.
  async system() {
    if (this.sys) return this.sys;
    const local = !this.machine;
    let posix = local ? window()?.platform !== "windows" : false;
    if (!local) { try { posix = (await this.run("sh", ["-c", "uname"])).code === 0; } catch { posix = false; } }
    let home = "";
    try {
      const r = posix ? await this.run("sh", ["-c", 'printf %s "$HOME"']) : await this.run("powershell.exe", ["-NoProfile", "-Command", "[Console]::Out.Write($env:USERPROFILE)"]);
      home = (r.stdout ?? "").trim();
    } catch {}
    this.sys = { posix, home, sep: posix ? "/" : "\\" };
    return this.sys;
  }

  base() { return store()[this.mk]?.base ?? null; }
  clones() { return store()[this.mk]?.clones ?? {}; }
  where(repo) { return this.clones()[repo.slug] ?? this.found[repo.slug] ?? null; }

  async load(cx) {
    try {
      const sys = await this.system();
      if (!this.base()) this.baseInput.set_value(sys.home ? `${sys.home}${sys.sep}projects` : "");
      else this.baseInput.set_value(this.base());
      cx.notify();
      await Promise.all([this.loadRepos(), this.scan(), this.prune()]);
    } catch (e) { this.error = String(e?.message ?? e); }
    cx.notify();
  }

  // Yours, your organizations' and ones you collaborate on, newest push first.
  async loadRepos() {
    let r;
    try {
      r = await this.run("gh", ["api", "--paginate", "user/repos?per_page=100&sort=pushed&affiliation=owner,organization_member,collaborator",
        "--jq", ".[] | [.full_name, .name, (.private|tostring), .pushed_at] | @tsv"], 60000);
    } catch { this.error = `gh isn't installed on ${this.machine ?? "this computer"}.`; this.repos = []; return; }
    if (r.code !== 0) {
      const msg = `${r.stderr ?? ""}${r.stdout ?? ""}`;
      this.error = /auth login|not logged|authentication/i.test(msg)
        ? `${this.machine ?? "This computer"} isn't logged in to GitHub: run gh auth login there.`
        : msg.trim().slice(0, 200) || "gh failed";
      this.repos = [];
      return;
    }
    const seen = new Set();
    this.repos = (r.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
      const [full, name, priv, pushed] = line.split("\t");
      return { slug: full.toLowerCase(), full, name, private: priv === "true", pushed };
    }).filter((x) => !seen.has(x.slug) && seen.add(x.slug))
      .sort((a, b) => String(b.pushed).localeCompare(String(a.pushed)));
  }

  // Clones under the default folder, one or two levels down, by their origin.
  async scan() {
    const base = this.base();
    if (!base) return;
    const sys = await this.system();
    let r;
    try {
      r = sys.posix
        ? await this.run("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; for d in */ */*/; do [ -e "$d.git" ] && printf "%s\\t%s\\n" "$PWD/${d%/}" "$(git -C "$d" remote get-url origin 2>/dev/null)"; done; exit 0', "sh", base])
        : await this.run("powershell.exe", ["-NoProfile", "-Command",
          `$b='${base.replace(/'/g, "''")}'; if (Test-Path -LiteralPath $b) { Get-ChildItem -LiteralPath $b -Directory -Depth 1 -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.git') } | ForEach-Object { $u = git -C $_.FullName remote get-url origin 2>$null; "$($_.FullName)\`t$u" } }`]);
    } catch { return; }
    const found = {};
    for (const line of (r.stdout ?? "").split(/\r?\n/)) {
      const [path, url] = line.split("\t");
      const slug = slugOf(url);
      if (path && slug && !found[slug]) found[slug] = path.trim();
    }
    this.found = found;
  }

  // Drop remembered clones whose folder is gone.
  async prune() {
    const clones = this.clones();
    const paths = Object.entries(clones);
    if (!paths.length) return;
    const sys = await this.system();
    const keep = {};
    for (const [slug, path] of paths) {
      try {
        const r = sys.posix ? await this.run("sh", ["-c", '[ -e "$1/.git" ]', "sh", path])
          : await this.run("powershell.exe", ["-NoProfile", "-Command", `if (Test-Path -LiteralPath '${path.replace(/'/g, "''")}\\.git') { exit 0 } else { exit 1 }`]);
        if (r.code === 0) keep[slug] = path;
      } catch { keep[slug] = path; } // machine away: keep it
    }
    if (Object.keys(keep).length !== paths.length) saveFor(this.mk, { clones: keep });
  }

  list() {
    const q = this.query;
    return (this.repos ?? []).filter((r) => !q || r.slug.includes(q));
  }

  close() { const id = props()?.overlay; if (id) closeOverlay(id); }

  // A space there: the one already showing that folder, else a new one (named after its repo by Herdr).
  open(path) {
    const s = spaces().find((x) => (x.machine ?? null) === this.machine && sameDir(x.folder, path));
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: path, machine: this.mk });
    this.close();
  }

  choose(repo, cx) {
    const path = this.where(repo);
    if (path) return this.open(path);
    this.picked = repo;
    cx.timer.after(30, () => this.baseInput.focus());
    cx.notify();
  }

  clone(cx) {
    const repo = this.picked;
    const base = this.baseInput.value().trim().replace(/[\\/]+$/, "");
    if (!repo || !base || this.busy) return;
    this.busy = `Cloning ${repo.full}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const sys = await this.system();
        const dest = `${base}${sys.sep}${repo.name}`;
        const mk = sys.posix ? await this.run("mkdir", ["-p", base])
          : await this.run("powershell.exe", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${base.replace(/'/g, "''")}' | Out-Null`]);
        if (mk.code !== 0) throw new Error(mk.stderr || "couldn't make the folder");
        const r = await this.run("gh", ["repo", "clone", repo.full, dest], 600000);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "clone failed").trim().slice(0, 300));
        saveFor(this.mk, { base, clones: { ...this.clones(), [repo.slug]: dest } });
        notify({ title: "Cloned", body: `${repo.full} → ${dest}`, level: "success" });
        this.open(dest);
      } catch (e) {
        this.busy = null;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  row(t, repo, i) {
    const path = this.where(repo);
    return h_flex().id(`repo-${i}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().flex_none()
      .hover((s) => s.bg(t.hover))
      .when(this.picked?.slug === repo.slug, (el) => el.bg(t.selected ?? t.hover))
      .on_click((_e, cx) => this.choose(repo, cx))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(repo.full))
      .when(repo.private, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("private")))
      .child(path
        ? div().flex_none().px(5).rounded(4).text_size(10.5).bg(t.raised ?? t.hover).text_color(t.done ?? t.foreground).tooltip(path).child("cloned")
        : div().flex_none().text_size(10.5).text_color(t.dim).child(ago(repo.pushed)));
  }

  render() {
    const t = theme();
    const list = this.list();
    const where = this.machine ?? "this computer";
    return v_flex().id("repo-menu").size_full().p(6).gap(6).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().gap(6).items_center().px(4)
        .child(div().flex_1().text_size(11).text_color(t.dim).child(`Open a repo on ${where}`))
        .when(this.repos === null, (el) => el.child(div().text_size(11).text_color(t.dim).child("Loading…"))))
      .child(Input.new(this.search).h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12))
      .when(Boolean(this.error), (el) => el.child(div().px(6).text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("repo-list").flex_1().min_h(0).overflow_y_scroll().gap(1)
        .children(list.slice(0, 200).map((r, i) => this.row(t, r, i)))
        .when(this.repos !== null && !list.length && !this.error, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No repos match."))))
      .when(Boolean(this.picked), (el) => el.child(v_flex().gap(5).p(6).rounded(6).border_1().border_color(t.border)
        .child(div().text_size(11.5).text_color(t.muted).child(`Clone ${this.picked.full} into (kept as ${where}'s default):`))
        .child(h_flex().gap(6).items_center()
          .child(Input.new(this.baseInput).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12))
          .child(div().id("repo-clone").h(28).px(10).flex().items_center().rounded(6).flex_none().text_size(12).font_medium()
            .bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? "#ffffff")
            .when(!this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.clone(cx)))
            .when(Boolean(this.busy), (el) => el.opacity(0.6))
            .child(this.busy ? "Cloning…" : "Clone")))
        .when(Boolean(this.busy), (el) => el.child(div().text_size(11).text_color(t.working ?? t.dim).child(this.busy)))))
      .child(div().h(1).flex_none().bg(t.border))
      .child(h_flex().id("repo-empty").h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().flex_none().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => { run("space.new", { machine: this.mk }); this.close(); })
        .child(svg("mods/workspace-chrome/plus.svg").size(12))
        .child("New empty space"));
  }
}
