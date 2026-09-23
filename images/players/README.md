# Player card images

Put one image per player here. **Must be `.png`** — the app only looks for that extension.

**Naming:** lowercase player name, accents stripped, everything else that isn't `a-z`/`0-9`
replaced with `-` (matches `playerImgSlug()` in app.js exactly).
Examples: `derke.png`, `zmjjkk.png`, `d-zed-o-brien.png`, `angel-nunez.png`
(when two players' names slug to the same thing, append the team, e.g. `leviatan-neon.png`).

Served as static files from the site root, e.g. `images/players/derke.png`.

**Used automatically** by the Team page slots, the player picker, and the captain list
(`playerAvatar()` in app.js) — no code change needed once a file lands here. Until a player's
file exists, their avatar shows a role-colored circle with their initial instead.
