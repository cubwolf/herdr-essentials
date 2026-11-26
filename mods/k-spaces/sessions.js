// k-spaces (herdr-essentials): the sessions an agent already had in a folder, for the space row's
// "+" menu: pick one to go on with it, or start a new one. Claude Code only: it keeps one .jsonl a
// session under ~/.claude/projects/<the folder, every other character a dash>/ on the machine it ran on.
// Read by one sh (Windows: PowerShell) there; the parts that don't run anything are tested.

export const MAX = 12;

/** Is this one of knownAgents() Claude Code? (by its key, or its program's name) */
export function isClaude(agent) {
  const prog = String(agent?.run?.[0] ?? "").split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  return ["claude", "claude-code"].includes(String(agent?.key ?? "").toLowerCase()) || prog === "claude";
}

/** The folder's name under ~/.claude/projects: /home/k/my.repo → -home-k-my-repo, C:\Users\x → C--Users-x. */
export const projectDir = (folder) => String(folder ?? "").replace(/[\\/]+$/, "").replace(/[^A-Za-z0-9]/g, "-");

/** What the agent is started with to go on with that session. */
export const resumeArgs = (id) => ["--resume", id];

// Both read only a session file's last 400 KB: they run to tens of MB (PowerShell's Get-Content -Tail
// took minutes on one, 2026-11-26 on the laptop).
// Newest first: a marker line, then that session's last title record, last prompt record, and how it
// was started ("entrypoint":"cli", or "sdk-cli" for a headless run); any of them may be missing.
export const POSIX = `d="$HOME/.claude/projects/$1"; [ -d "$d" ] || exit 0; ls -t "$d"/*.jsonl 2>/dev/null | head -${MAX} | while IFS= read -r f; do m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"); b=\${f##*/}; echo "<<S \${b%.jsonl} $m>>"; tail -c 400000 "$f" | grep -a '"type":"[a-z]*-title"' | tail -1 | cut -c1-800; tail -c 400000 "$f" | grep -a '"type":"last-prompt"' | tail -1 | cut -c1-1200; tail -c 400000 "$f" | grep -a -o '"entrypoint":"[^"]*"' | tail -1; done`;
export const PS = (dir) => `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $d=Join-Path $env:USERPROFILE '.claude\\projects\\${dir}'; if(Test-Path -LiteralPath $d){ Get-ChildItem -LiteralPath $d -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First ${MAX} | % { "<<S $($_.BaseName) $([DateTimeOffset]::new($_.LastWriteTimeUtc).ToUnixTimeSeconds())>>"; $fs=[IO.File]::Open($_.FullName,'Open','Read','ReadWrite'); $n=[int][Math]::Min($fs.Length,400000); [void]$fs.Seek(-$n,'End'); $b=New-Object byte[] $n; $r=0; while($r -lt $n){ $k=$fs.Read($b,$r,$n-$r); if($k -le 0){ break }; $r+=$k }; $fs.Close(); $t=[Text.Encoding]::UTF8.GetString($b,0,$r) -split [char]10; ($t | Select-String -Pattern '"type":"[a-z]*-title"' | Select-Object -Last 1).Line; ($t | Select-String -SimpleMatch '"type":"last-prompt"' | Select-Object -Last 1).Line; $e=($t | Select-String -Pattern '"entrypoint":"[^"]*"' | Select-Object -Last 1); if($e){ $e.Matches[0].Value } } }`;

// A JSON string's value by its key, from a line that may have been cut short.
function field(line, key) {
  const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)`).exec(line);
  if (!m) return "";
  try { return JSON.parse(`"${m[1].replace(/\\$/, "")}"`); } catch { return m[1]; }
}
const tidy = (s) => String(s ?? "").replace(/<[^>]{1,40}>/g, " ").replace(/\s+/g, " ").trim();

/** The script's output → [{ id, at (ms), title, prompt }], newest first. A session with neither a
 *  title nor a prompt (an empty one) is left out, and so is a headless run (`claude -p`: k-chat's
 *  members, scripts), which nobody had on screen. */
export function parse(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const head = /^<<S ([0-9A-Za-z-]{8,64}) (\d+)>>$/.exec(line.trim());
    if (head) { cur = { id: head[1], at: Number(head[2]) * 1000, title: "", prompt: "", headless: false }; out.push(cur); continue; }
    if (!cur) continue;
    const entry = /^"entrypoint":"([^"]*)"$/.exec(line.trim());
    if (entry) { cur.headless = entry[1].startsWith("sdk"); continue; }
    if (/"type":"[a-z]*-title"/.test(line)) cur.title = tidy(field(line, "aiTitle") || field(line, "customTitle") || field(line, "title"));
    else if (line.includes('"type":"last-prompt"')) cur.prompt = tidy(field(line, "lastPrompt"));
  }
  return out.filter((s) => !s.headless && (s.title || s.prompt)).map(({ headless, ...s }) => s);
}

/** "3m", "5h", "2d": how long ago. */
export function ago(at, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/** Claude Code's sessions in `folder` on `machine` (null: this one). `exec`: herdr's; `posix`: that machine's shell. */
export async function list(exec, { folder, machine = null, posix = true }) {
  const dir = projectDir(folder);
  if (!dir) return [];
  const on = { on: machine ?? null, timeout: 20000 };
  const r = posix ? await exec("sh", ["-c", POSIX, "k-sessions", dir], on) : await exec("powershell.exe", ["-NoProfile", "-Command", PS(dir)], on);
  return parse(r.stdout);
}
