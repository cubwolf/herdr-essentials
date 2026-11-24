// k-pane: the pure part (no `herdr` import, so `node --test` can load it): what other mods may
// put in a pane header, and which of it one pane shows.
//
// shared "k-pane.chips" = { <mod name>: { <terminal address>: chip } }, each mod writing only its
// own key. A chip: { label?, text?, tone?, tag?, color?, tip?, url? }
//   label: small muted lead ("#290")      text: the main words, cut when narrow
//   tone:  theme color of the text        tag:  a small pill after it, color: its theme color
//   tip:   tooltip                        url:  opened in the browser on click (http / https only)

const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// Every mod the layout holds: its blocks' and its pane headers'.
export function modsIn(node, out = new Set()) {
  const c = node?.content;
  if (typeof c?.mod === "string") out.add(c.mod);
  const head = c?.pane?.header?.content?.mod;
  if (typeof head === "string") out.add(head);
  for (const child of node?.children ?? []) modsIn(child, out);
  return out;
}

export function safeUrl(url) {
  return typeof url === "string" && /^https?:\/\/[^\s"'<>\\^`{|}]+$/i.test(url) ? url : null;
}

// The chips of one terminal, by mod name. A mod that is no longer in the layout (removed, or
// another layout is shown) is left out: shared data outlives the mod that wrote it.
export function chipsFor(given, address, mods) {
  const out = [];
  if (!address || !given || typeof given !== "object" || Array.isArray(given)) return out;
  for (const by of Object.keys(given).sort()) {
    const g = mods.has(by) ? given[by]?.[address] : null;
    if (!g || typeof g !== "object") continue;
    const chip = {
      by, label: str(g.label, 40), text: str(g.text, 300), tone: str(g.tone, 40), tag: str(g.tag, 40), color: str(g.color, 40),
      tip: typeof g.tip === "string" ? g.tip.slice(0, 1000) : "", url: safeUrl(g.url),
    };
    if (chip.label || chip.text || chip.tag) out.push(chip);
  }
  return out;
}
