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
- Used in: `mods/k-tabs/` (from `tabs`), `mods/k-spaces/` (from `spaces`), `mods/k-chrome/`
  (from `workspace-chrome`). These are modified copies of Herdr 0.1.16's built-in mods; each
  file's header says what was changed.
