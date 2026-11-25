// k-float (herdr-essentials, ADR 0005): desktop windows for mods. A mod's own overlays are drawn
// inside the Herdr window; these are real system windows, always on top of every other program,
// showing the HTML you give them. A helper program (tools/k-float, one per App home) opens them
// from files, so an agent or a script can do the same without a mod: doc/k-float-protocol.md.
//
//   import { float } from "./float.js";      // copy this file into your mod: a mod imports only from its own folder
//
//   float.listen(cx, "hello", (event, cx) => {            // in init(), before open()
//     if (event.type === "message") float.update("hello", { data: { count: ++this.count } });
//     if (event.type === "closed") …                      // the person closed it (by: "user")
//   });
//   await float.open({ id: "hello", width: 240, height: 120, data: { count: 0 },
//     html: `<button onclick="float.send('add')">+</button> <b id=n></b>
//            <script>float.onData((d) => { n.textContent = d.count; })</script>` });
//   await float.close("hello");
//
// In the page: float.send(value) → a "message" event here; float.onData(fn) ← update(id, { data }).
// Changing `data` doesn't reload the page (what is being typed stays); changing `html` does.
import { exec, appHome, watchFolder, window as appWindow } from "herdr";
import * as fs from "fs/promises";

const root = () => appHome().replace(/[\\/]+$/, "");
/** The folder the helper works from: windows/<id>.json in, events/<id>.jsonl out. */
export const dir = () => `${root()}/data/k-float`;
/** The helper, built by install.sh (cargo build --release in tools/k-float). */
export const helper = () => `${root()}/tools/k-float/target/release/k-float${appWindow()?.platform === "windows" ? ".exe" : ""}`;

const specPath = (id) => `${dir()}/windows/${id}.json`;
const eventsPath = (id) => `${dir()}/events/${id}.jsonl`;

function check(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`k-float: id must be 1-64 letters, digits, ".", "_" or "-" (got ${JSON.stringify(id)})`);
  return id;
}

async function read(path) {
  try { return (await fs.exists(path)) ? await fs.readFile(path, "utf8") : null; } catch { return null; }
}

// Starts the helper unless it runs already; it leaves by itself 30 seconds after its last window.
async function start() {
  let r;
  try { r = await exec(helper(), ["start", dir()], { timeout: 15000 }); }
  catch (e) { throw new Error(`k-float: the helper isn't installed (${helper()}): run install.sh. ${e?.message ?? e}`); }
  if (r.code !== 0) throw new Error(`k-float: the helper failed to start: ${(r.stderr || r.stdout || "").trim()}`);
}

async function write(id, spec) {
  await fs.mkdir(`${dir()}/windows`, { recursive: true });
  await fs.writeFile(specPath(id), JSON.stringify(spec));
  await start();
}

/** Resolves after `ms` (mods have no setTimeout). */
export const sleep = (cx, ms) => new Promise((done) => { cx.timer.after(ms, () => done()); });

function events(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (typeof e?.seq === "number") out.push(e); } catch {} // a line still being written
  }
  return out;
}

export const float = {
  /** Opens a window, or replaces the one with this id.
   *  { id, html, data?, title?, x?, y?, width?, height?, topmost? (true), clickThrough? (false),
   *    opacity? (1: opaque; 0.8 lets a little of what is behind show through),
   *    frame? (true: the system's title bar), taskbar? (false) }; x, y, width, height in logical pixels. */
  async open(spec) {
    const { id, ...rest } = spec ?? {};
    await write(check(id), rest);
  },

  /** Changes some fields of an open window. False if it isn't open (closed by the person, say). */
  async update(id, patch) {
    let now = null;
    // Someone may be writing the file this instant (the helper, another update): read again
    // rather than take half a file for an empty spec and write the patch alone over the rest.
    for (let tries = 0; now == null; tries++) {
      const text = await read(specPath(check(id)));
      if (text == null) return false;
      try { now = JSON.parse(text); } catch (e) { if (tries >= 8) throw new Error(`k-float: ${id}'s spec can't be read (${e?.message ?? e}); not changed`); }
    }
    const { id: _id, ...rest } = patch ?? {};
    await write(id, { ...now, ...rest });
    return true;
  },

  /** Closes a window. Fine if it is closed already. */
  async close(id) {
    try { if (await fs.exists(specPath(check(id)))) await fs.unlink(specPath(id)); } catch {}
  },

  /** The window's spec as it is now (the helper keeps x, y, width, height current), or null if closed. */
  async get(id) {
    const text = await read(specPath(check(id)));
    try { return text == null ? null : JSON.parse(text); } catch { return null; }
  },

  /** Calls handler(event, cx) for what happens to a window from now on:
   *    { type: "ready" }                          its page loaded
   *    { type: "message", data }                  the page called float.send(data)
   *    { type: "moved", x, y } / { type: "resized", width, height }   by the person, once they let go
   *    { type: "closed", by: "user" | "spec" }
   *    { type: "error" | "warning", message }
   *  Each also has `seq` and `t` (milliseconds). Runs as a task of `cx`: it ends with the mod copy.
   *  `replay: true` also delivers what is already in the file. */
  listen(cx, id, handler, { replay = false } = {}) {
    check(id);
    return cx.spawn(async (cx) => {
      let last = null;
      for (;;) {
        const began = Date.now();
        let fresh = [];
        try {
          await fs.mkdir(`${dir()}/events`, { recursive: true }); // someone may have removed the folder
          // Watch first, read second: nothing written between the two is missed.
          const changed = watchFolder(`${dir()}/events`);
          const all = events(await read(eventsPath(id)));
          const end = all.length ? all[all.length - 1].seq : 0;
          if (last == null) last = replay ? 0 : end;
          if (end < last) last = 0; // the file was started over
          fresh = all.filter((e) => e.seq > last);
          if (fresh.length) { last = end; changed.cancel(); }
          else await changed;
        } catch (err) { console.log(`k-float: ${id} listen: ${err?.message ?? err}`); }
        for (const e of fresh) { try { await handler(e, cx); } catch (err) { console.log(`k-float: ${id} handler: ${err?.message ?? err}`); } }
        if (fresh.length) cx.notify();
        // A watch that can't wait (a missing folder, too many watches) must not become a busy loop.
        else if (Date.now() - began < 100) await sleep(cx, 500);
      }
    });
  },
};

export default float;
