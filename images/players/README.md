# Player card images

Put one image per player here. **Must be `.png`** — the app only looks for that extension.

**Naming: `[team]-[player].png`.** Each part is lowercased, accents stripped, and everything
that isn't `a-z`/`0-9` replaced with `-` (matches `playerImgSlug()`/`playerImgSrc()` in app.js
exactly — team first, then player, joined with a single `-`).

Examples:
- `Team Vitality` + `Derke` → `team-vitality-derke.png`
- `Leviatán` + `Ángel Núñez` → `leviatan-angel-nunez.png`
- `Team Vitality` + `D'zed O'Brien` → `team-vitality-d-zed-o-brien.png`

Served as static files from the site root, e.g. `images/players/team-vitality-derke.png`.

**Used automatically** by the Team page slots, the player picker, and the captain list
(`playerAvatar()` in app.js) — no code change needed once a file lands here. Until a player's
file exists, their avatar shows a role-colored circle with their initial instead.
