# Third-party notices

Parts of this repository are derived from other people's work. Their licenses and copyright
notices are kept as required.

## jacksonpires/herdr-app-mod-manager (MIT)

- Source: https://github.com/jacksonpires/herdr-app-mod-manager
- Copyright (c) 2026 speardragon, Copyright (c) 2026 Jackson Pires
- License: MIT, full text in [`mods/k-settings/LICENSE`](mods/k-settings/LICENSE)
- Used in: `mods/k-settings/` (`core.js`, `mods.js`; was `mods/k-mods/`) and `tests/k-mods.test.js`.
  k-mods is a modified version: English UI, a VS Code-style mouse-first layout, a platform file
  layer for Windows, and enable / disable. Each derived file says so in its header.

## herdrdev/herdr-app built-in mods (Apache-2.0)

- Source: https://github.com/herdrdev/herdr-app (the mods Herdr ships in `~/.config/herdr-app/mods`)
- License: Apache License 2.0
- Used in (modified copies of Herdr 0.1.16's built-in mods and settings screen; each file's
  header says what it started from and what was changed):
  - `mods/k-tabs/` (from `tabs`)
  - `mods/k-spaces/` (from `spaces`; the "+" menu from `new-menu`)
  - `mods/k-chrome/` (from `workspace-chrome`)
  - `mods/k-agents/` (from `agents`)
  - `mods/k-files/` (from `files`)
  - `mods/k-settings/main.js` (from `frame/settings`)
- Full license text: [`LICENSE`](LICENSE) (this repository is Apache-2.0 as well). Upstream ships
  no NOTICE file.

## Lucide icons (ISC, with MIT-licensed Feather-derived icons)

- Source: https://lucide.dev
- Used in: the `.svg` glyphs under `mods/*/`, either taken from Lucide directly or copied with
  Herdr's built-in mods (which use Lucide). A few simple ones (window buttons, the k-pick
  crosshair) were drawn for this repository.
- Full notices: [`licenses/LICENSE-Lucide.txt`](licenses/LICENSE-Lucide.txt)

## OliverRC/herdr-model-effort (Apache-2.0)

- Source: https://github.com/OliverRC/herdr-model-effort
- `tools/statusline/herdr-statusline.sh` follows its approach (a Claude Code statusLine command
  that writes `herdr.model` / `herdr.effort` terminal labels) and its label names. The script was
  written for this repository; no code was copied.
