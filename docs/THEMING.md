# Theming & White-Label Guide

How the theme system works and what to touch when rebranding a downstream clone.

## Where things live

| What | Where |
|---|---|
| Built-in presets | `static/js/theme.js` — `THEMES` map (slug → colors). Rendered as the "Default Themes" grid in the Theme popup. |
| Stylesheet defaults (pre-JS first paint) | `static/style.css` — `:root` (dark default = **Dusk**) and `:root.light` (light = **Golden Hour**). |
| First-paint bootstrap | Inline script near the top of `static/index.html` — reads localStorage, sets CSS vars, `<meta name="theme-color">`, favicon accent, and auto-derives all `--hl-*` syntax colors from `bg`/`fg`/`red` via HSL math. |
| Default selected theme | `DEFAULT_THEME` in `static/js/theme.js` (currently `'dusk'`). Used when localStorage is empty. |
| PWA chrome | `static/manifest.json` (`background_color`, `theme_color`), the `theme-color` meta in `index.html`, and `static/login.html` token block. |

## Saved theme JSON shape

Stored in localStorage under `odysseus-theme` (and synced to `/api/prefs/theme`):

```json
{
  "name": "dusk",
  "colors": {
    "bg": "#1A1420", "fg": "#F4ECE4", "panel": "#241B2B",
    "border": "#3A2E42", "red": "#E8643C",
    "advanced": { "sidebarBg": "#150F1A", "brandColor": "#F2A03D", "...": "..." }
  },
  "font": "mono", "density": "comfortable", "bgPattern": "none"
}
```

All `advanced` keys are optional; CSS falls back sensibly (e.g. `var(--sidebar-bg, var(--panel))`). The `advanced` → CSS var map lives in the `index.html` bootstrap (`advMap`) and in `ADV_KEYS` in `theme.js`.

Don't hand-tune `--hl-*` syntax colors — they're derived from `bg`/`fg`/`red` at runtime. Only override if the derived output is illegible.

## Rebranding a clone: the three touch points

1. **`--brand-color`** — set via the preset's `advanced.brandColor` (logo, wordmark, section accents).
2. **`red`** (the primary accent) — buttons, links, active states, favicon accent.
3. **`static/manifest.json`** — `background_color` / `theme_color` + app name/short_name/icons.

Also update: the `theme-color` meta and hardcoded favicon fallback hexes in `index.html`, the `:root` token block in `login.html`, and the `:root` defaults in `style.css` so the pre-JS first paint matches your brand. Grep for the old hexes — every brand color in chrome files is a literal that must match the default preset.

After any CSS/JS change, bump `CACHE_NAME` in `static/sw.js` so installed PWAs pick it up.

## Current brand palettes (locked)

**Dusk (dark, default):** bg `#1A1420`, panel `#241B2B`, sidebar `#150F1A`, border `#3A2E42`, fg `#F4ECE4`, secondary `#B8A99C`, accent/ember `#E8643C` (hover `#F2784F`), brand/gold `#F2A03D`, error/rose `#C94F6D`. Send button uses darkened ember `#B54E2F` (hover `#C55533`) so the white icon/label clears WCAG AA — raw ember only reaches 2.95:1.

**Golden Hour (light):** bg `#F7F3ED`, panel `#FDFBF7`, sidebar `#EFE8DE`, border `#DDD2C2`, fg `#42342A`, secondary `#7D6F60`, accent/clay `#C2602E` (hover `#AD5527`), brand `#A8511F`, honey `#D9A05B` (decorative only — never text), error `#A84A52`. Send button uses darkened clay `#A55227` (hover `#974B24`) for the same contrast reason.

The original blue-gray theme remains selectable as the "classic" preset.
