// k-tabs paste shot (herdr-essentials): when the clipboard holds an image, a button saves it
// as a PNG and pastes that file's path into the focused terminal, the way Attach does (Claude
// Code turns it into an image). Herdr's own Ctrl+V on Windows only pastes text.
import { exec, notify, window } from "herdr";
import { pasteFiles } from "./attach.js";

const PS = (body) => ["-NoProfile", "-STA", "-Command",
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " + body];

// Unix: is there an image (PNG) on the clipboard? Wayland wl-paste, else X11 xclip, macOS osascript.
const SH_HAS = `has() {
  if [ "$(uname)" = Darwin ]; then osascript -e 'clipboard info' 2>/dev/null | grep -q PNGf; return; fi
  if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null; then wl-paste --list-types 2>/dev/null
  else xclip -selection clipboard -t TARGETS -o 2>/dev/null; fi | grep -qx 'image/png'
}`;

// Waits until the clipboard's "has an image" differs from `had`, then prints 1 or 0. One small
// process at a time instead of a new one every tick; gives up (prints the old state) after ~9 min.
function watchArgs(platform, had) {
  const h = had ? 1 : 0;
  if (platform === "windows") return ["powershell.exe", PS(
    `$h = ${had ? "$true" : "$false"}; for ($n = 0; $n -lt 540; $n++) { ` +
    // Locked screen: the clipboard can't be opened and this throws; keep waiting instead of answering.
    `try { $c = [Windows.Forms.Clipboard]::ContainsImage() } catch { Start-Sleep -Seconds 1; continue }; ` +
    `if ($c -ne $h) { if ($c) { '1' } else { '0' }; exit }; Start-Sleep -Seconds 1 }; '${h}'`)];
  return ["sh", ["-c", `${SH_HAS}
for i in $(seq 540); do if has; then c=1; else c=0; fi; [ $c != ${h} ] && { echo $c; exit 0; }; sleep 1; done; echo ${h}`]];
}

// Calls `onChange(hasImage)` whenever that changes, for as long as `alive()` is true.
// `wait(ms)` pauses; a watcher that comes back unchanged too soon (something failing) backs off.
export async function watchClipboard(alive, onChange, wait) {
  const platform = window()?.platform ?? "linux";
  let had = false;
  while (alive()) {
    let r;
    const started = Date.now();
    try { const [cmd, args] = watchArgs(platform, had); r = await exec(cmd, args, { timeout: 600000 }); } catch { return; }
    if (r.code !== 0) return; // no clipboard tool here: the button just never shows
    const now = r.stdout.trim().endsWith("1");
    if (now !== had) { had = now; onChange(now); }
    else if (Date.now() - started < 5000) await wait(30000);
  }
}

// Clipboard image -> a new PNG in the temp folder; its path, or null.
async function save(platform) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  if (platform === "windows") {
    const r = await exec("powershell.exe", PS(
      "$i = [Windows.Forms.Clipboard]::GetImage(); if (-not $i) { exit 1 }; " +
      `$p = Join-Path ([IO.Path]::GetTempPath()) 'herdr-shot-${stamp}.png'; $i.Save($p, [Drawing.Imaging.ImageFormat]::Png); $p`));
    return r.code === 0 ? r.stdout.trim() : null;
  }
  const r = await exec("sh", ["-c", `f="\${TMPDIR:-/tmp}"; f="\${f%/}/herdr-shot-${stamp}.png"
if [ "$(uname)" = Darwin ]; then osascript -e "set fh to open for access POSIX file \\"$f\\" with write permission" -e 'write (the clipboard as «class PNGf») to fh' -e 'close access fh' >/dev/null
elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null; then wl-paste --type image/png > "$f"
else xclip -selection clipboard -t image/png -o > "$f"; fi
[ -s "$f" ] && echo "$f"`]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Put the PNG back on the clipboard (pasting borrowed it for the path).
function putBack(platform, file) {
  const q = file.replace(/'/g, "''");
  if (platform === "windows") return exec("powershell.exe", PS(`[Windows.Forms.Clipboard]::SetImage([Drawing.Image]::FromFile('${q}'))`));
  return exec("sh", ["-c", `if [ "$(uname)" = Darwin ]; then osascript -e "set the clipboard to (read (POSIX file \\"$1\\") as «class PNGf»)"
elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null; then wl-copy --type image/png < "$1" >/dev/null 2>&1 &
else xclip -selection clipboard -t image/png -i "$1" >/dev/null 2>&1 & fi`, "sh", file]);
}

export async function pasteShot(cx) {
  const platform = window()?.platform ?? "linux";
  const file = await save(platform);
  if (!file) { notify({ title: "Paste shot", body: "No image on the clipboard.", level: "warning" }); return; }
  await pasteFiles(cx, [file], () => { putBack(platform, file); });
}
