// k-spaces' session list (mods/k-spaces/sessions.js): the folder's name under ~/.claude/projects,
// reading the script's output, and the script itself on a made-up home (POSIX only).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectDir, parse, ago, isClaude, resumeArgs, POSIX, list } from "../mods/k-spaces/sessions.js";

test("projectDir: every other character becomes a dash", () => {
  assert.equal(projectDir("/home/k/my.repo_x/"), "-home-k-my-repo-x");
  assert.equal(projectDir("C:\\Users\\DDT\\Desktop\\projects\\a b"), "C--Users-DDT-Desktop-projects-a-b");
  assert.equal(projectDir(null), "");
});

test("isClaude, resumeArgs, ago", () => {
  assert.ok(isClaude({ key: "claude", run: ["claude"] }));
  assert.ok(isClaude({ key: "x", run: ["C:\\bin\\claude.cmd"] }));
  assert.ok(!isClaude({ key: "codex", run: ["codex"] }));
  assert.deepEqual(resumeArgs("abc"), ["--resume", "abc"]);
  assert.deepEqual([0, 5 * 60000, 3 * 3600000, 2 * 86400000].map((d) => ago(1e12 - d, 1e12)), ["now", "5m", "3h", "2d"]);
});

test("parse: title and last prompt, cut-off lines, sessions with nothing to show are left out", () => {
  const out = parse([
    "<<S 11111111-aaaa 1700000000>>",
    '{"type":"ai-title","aiTitle":"修 \\"tab\\" 列","sessionId":"x"}',
    '{"type":"last-prompt","lastPrompt":"<pasted>好</pasted>,commit 並 pu',
    "<<S 22222222-bbbb 1690000000>>",
    "<<S 33333333-cccc 1680000000>>\r",
    '{"type":"last-prompt","lastPrompt":"只有這句","leafUuid":"y"}',
    "noise",
    "<<S 44444444-dddd 1670000000>>",
    '{"type":"last-prompt","lastPrompt":"無頭跑的(claude -p)"}',
    '"entrypoint":"sdk-cli"',
    "<<S 55555555-eeee 1660000000>>",
    '{"type":"ai-title","aiTitle":"畫面上開的"}',
    '"entrypoint":"cli"',
  ].join("\n"));
  assert.deepEqual(out, [
    { id: "11111111-aaaa", at: 1700000000000, title: '修 "tab" 列', prompt: "好 ,commit 並 pu" },
    { id: "33333333-cccc", at: 1680000000000, title: "", prompt: "只有這句" },
    { id: "55555555-eeee", at: 1660000000000, title: "畫面上開的", prompt: "" },
  ]);
  assert.deepEqual(parse(""), []);
});

test("the script: newest first, from the folder's own directory only", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "k-sess-"));
  try {
    const dir = path.join(home, ".claude", "projects", projectDir("/w/repo"));
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "projects", "-w-other"));
    fs.writeFileSync(path.join(home, ".claude", "projects", "-w-other", "zzzzzzzz-1.jsonl"), '{"type":"ai-title","aiTitle":"別的資料夾"}\n');
    fs.writeFileSync(path.join(dir, "aaaaaaaa-1.jsonl"), '{"type":"ai-title","aiTitle":"舊的"}\n{"type":"user"}\n{"type":"ai-title","aiTitle":"舊的,改過名"}\n');
    fs.writeFileSync(path.join(dir, "bbbbbbbb-2.jsonl"), '{"type":"user","entrypoint":"cli","x":1}\n{"type":"last-prompt","lastPrompt":"新的那句"}\n');
    fs.writeFileSync(path.join(dir, "cccccccc-3.jsonl"), '{"type":"user","entrypoint":"sdk-cli"}\n{"type":"last-prompt","lastPrompt":"無頭"}\n');
    fs.utimesSync(path.join(dir, "aaaaaaaa-1.jsonl"), 1000, 1000);
    fs.utimesSync(path.join(dir, "bbbbbbbb-2.jsonl"), 2000, 2000);
    const exec = async (cmd, args) => { const r = spawnSync(cmd, args, { env: { ...process.env, HOME: home }, encoding: "utf8" }); return { code: r.status, stdout: r.stdout }; };
    assert.deepEqual(await list(exec, { folder: "/w/repo" }), [
      { id: "bbbbbbbb-2", at: 2000000, title: "", prompt: "新的那句" },
      { id: "aaaaaaaa-1", at: 1000000, title: "舊的,改過名", prompt: "" },
    ]);
    assert.deepEqual(await list(exec, { folder: "/w/none" }), []);
    assert.ok(POSIX.includes("head -12"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
