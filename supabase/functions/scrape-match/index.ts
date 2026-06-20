// Valotasy — scrape-match Edge Function
// Scrapes a VLR.gg match URL, calculates scores for all teams,
// stores results in match_player_cache, score_logs, matchday_scores.
//
// POST body: { match_url: string, matchday_id: number, tournament_id: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Scoring formula (new criteria) ──────────────────────────────
function calculateScore(
  stats: {
    kills: number; k4: number; k5: number; k6: number; k7: number;
    clutch_1v2: number; clutch_1v3: number; clutch_1v4: number; clutch_1v5: number;
    is_winner: boolean; clean_sheet_win: boolean;
  },
  ratingRank: number,
  isLowestRating: boolean,
  isCaptain: boolean,
  chip: string | null,
): { rawPts: number; finalPts: number } {
  let pts = 0;

  pts += Math.floor(stats.kills / 10);         // every 10 kills = +1
  pts += stats.k4 * 3;                          // 4K = +3
  pts += stats.k5 * 4;                          // 5K = +4
  pts += stats.k6 * 5;                          // 6K = +5
  pts += stats.k7 * 5;                          // 7K = +5

  // Clutch: each clutch = +1 regardless of type
  const totalClutch = stats.clutch_1v2 + stats.clutch_1v3 + stats.clutch_1v4 + stats.clutch_1v5;
  pts += totalClutch * 1;

  // Rating 2.0 rank within match
  if (ratingRank === 1) pts += 3;
  else if (ratingRank === 2) pts += 2;
  else if (ratingRank === 3) pts += 1;
  if (isLowestRating) pts -= 3;

  // Win / clean sheet
  if (stats.is_winner) {
    pts += 2;
    if (stats.clean_sheet_win) pts += 1;
  }

  const rawPts = pts;

  // Captain multiplier
  let finalPts = rawPts;
  if (chip === "triplecap" && isCaptain) finalPts = rawPts * 3;
  else if (isCaptain) finalPts = rawPts * 2;

  return { rawPts, finalPts };
}

// ── Debug: per-player score breakdown ───────────────────────────
function scoreBreakdown(
  stats: {
    kills: number; k4: number; k5: number; k6: number; k7: number;
    clutch_1v2: number; clutch_1v3: number; clutch_1v4: number; clutch_1v5: number;
    is_winner: boolean; clean_sheet_win: boolean;
  },
  ratingRank: number,
  isLowestRating: boolean,
  isCaptain: boolean,
  chip: string | null,
  topFraggerDoubled = false,
) {
  const killPts   = Math.floor(stats.kills / 10);
  const k4pts     = stats.k4 * 3;
  const k5pts     = stats.k5 * 4;
  const k6pts     = stats.k6 * 5;
  const k7pts     = stats.k7 * 5;
  const clutch    = stats.clutch_1v2 + stats.clutch_1v3 + stats.clutch_1v4 + stats.clutch_1v5;
  const clutchPts = clutch;
  const ratingPts = ratingRank === 1 ? 3 : ratingRank === 2 ? 2 : ratingRank === 3 ? 1 : 0;
  const lowestPts = isLowestRating ? -3 : 0;
  const winPts    = stats.is_winner ? 2 : 0;
  const csPts     = (stats.is_winner && stats.clean_sheet_win) ? 1 : 0;
  const rawPts    = killPts + k4pts + k5pts + k6pts + k7pts + clutchPts + ratingPts + lowestPts + winPts + csPts;

  let captainMult = 1;
  if (topFraggerDoubled) captainMult = 2;
  else if (chip === "triplecap" && isCaptain) captainMult = 3;
  else if (isCaptain) captainMult = 2;

  return {
    kills: stats.kills, killPts,
    k4: stats.k4, k4pts, k5: stats.k5, k5pts, k6: stats.k6, k6pts, k7: stats.k7, k7pts,
    clutch1v2: stats.clutch_1v2, clutch1v3: stats.clutch_1v3,
    clutch1v4: stats.clutch_1v4, clutch1v5: stats.clutch_1v5,
    clutchTotal: clutch, clutchPts,
    ratingRank, ratingPts,
    isLowestRating, lowestPts,
    isWinner: stats.is_winner, winPts,
    cleanSheet: stats.clean_sheet_win, cleanSheetPts: csPts,
    rawPts, captainMult, finalPts: rawPts * captainMult,
  };
}

// ── VLR HTML parser ──────────────────────────────────────────────
function parseNum(text: string): number {
  const m = text.replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

async function fetchVLR(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`VLR fetch failed: ${res.status} ${url}`);
  return res.text();
}

interface PlayerStats {
  displayName: string;
  kills: number;
  deaths: number;
  acs: number;
  rating20: number;
  k4: number; k5: number; k6: number; k7: number;
  clutch1v2: number; clutch1v3: number; clutch1v4: number; clutch1v5: number;
  isWinner: boolean;
  cleanSheetWin: boolean;
}

// Returns the HTML substring belonging to the "All Maps" game section.
// Uses vm-stats-game[^a-z] to avoid matching vm-stats-gamesnav-item nav tabs.
function extractAllMapsSection(html: string): string {
  const m = html.match(/<div[^>]+class="vm-stats-game[^a-z][^"]*"[^>]*data-game-id="all"[^>]*>/);
  if (!m || m.index == null) return "";
  const start = m.index;
  const rest = html.slice(start + m[0].length);
  const next = rest.match(/<div[^>]+class="vm-stats-game[^a-z][^"]*"[^>]*data-game-id="\d+"[^>]*>/);
  const end = next?.index != null ? start + m[0].length + next.index : html.length;
  return html.slice(start, end);
}

function scrapeOverview(html: string): { stats: Record<string, PlayerStats>; matchId: string; resultA: number; resultB: number } {
  // Parse series score from the explicit loser/winner spans — avoids matching map durations
  let winnerTeamIdx = -1;
  let cleanSheet = false;
  let resultA = 0, resultB = 0;
  const loserM = html.match(/match-header-vs-score-loser[^>]*>\s*(\d+)/);
  const winnerM = html.match(/match-header-vs-score-winner[^>]*>\s*(\d+)/);
  if (loserM && winnerM) {
    const loserScore = parseInt(loserM[1]);
    const winnerScore = parseInt(winnerM[1]);
    cleanSheet = loserScore === 0;
    // Whichever class appears first in the HTML corresponds to the first/left team (table index 0)
    const loserFirst = html.indexOf("match-header-vs-score-loser") < html.indexOf("match-header-vs-score-winner");
    if (loserFirst) {
      resultA = loserScore; resultB = winnerScore; winnerTeamIdx = 1;
    } else {
      resultA = winnerScore; resultB = loserScore; winnerTeamIdx = 0;
    }
  }

  // Isolate the All Maps section so we don't accidentally parse per-map tables
  const allHtml = extractAllMapsSection(html);
  if (!allHtml) return { stats: {}, matchId: "", resultA, resultB };

  // Parse the two mod-overview tables inside the All Maps section (one per team)
  const stats: Record<string, PlayerStats> = {};
  const tableRegex = /<table[^>]*class="[^"]*wf-table-inset mod-overview[^"]*"[\s\S]*?<\/table>/g;
  const tables = [...allHtml.matchAll(tableRegex)];
  const teamTables = tables.slice(0, 2); // first two = team A and team B in All Maps

  teamTables.forEach((match, tIdx) => {
    const isWinner = tIdx === winnerTeamIdx;
    const isCleanWin = isWinner && cleanSheet;
    const table = match[0];

    // Parse header to find column indices
    const headerMatch = table.match(/<thead[\s\S]*?<\/thead>/);
    if (!headerMatch) return;
    const headers = [...headerMatch[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
      .map(h => h[1].replace(/<[^>]+>/g, "").trim().toLowerCase());

    const colRating = headers.findIndex(h => h === "r" || h === "rating");
    const colAcs = headers.findIndex(h => h === "acs");
    const colK = headers.findIndex(h => h === "k");
    const colD = headers.findIndex(h => h === "d");

    // Parse each player row
    const rowRegex = /<tr[\s\S]*?<\/tr>/g;
    const tbody = table.match(/<tbody[\s\S]*?<\/tbody>/);
    if (!tbody) return;

    for (const rowMatch of tbody[0].matchAll(rowRegex)) {
      const row = rowMatch[0];
      const nameMatch = row.match(/class="text-of"[^>]*>([\s\S]*?)<\/div>/);
      if (!nameMatch) continue;
      const displayName = nameMatch[1].replace(/<[^>]+>/g, "").trim().split("\n")[0].trim();
      if (!displayName) continue;
      const nk = displayName.toLowerCase();

      const cells = [...row.matchAll(/<td[\s\S]*?<\/td>/g)].map(c => c[0]);

      function getCellNum(idx: number): number {
        if (idx < 0 || idx >= cells.length) return 0;
        // prefer mod-both span
        const modBoth = cells[idx].match(/class="[^"]*mod-both[^"]*"[^>]*>([\s\S]*?)<\/span>/);
        if (modBoth) return parseNum(modBoth[1]);
        return parseNum(cells[idx].replace(/<[^>]+>/g, ""));
      }

      stats[nk] = {
        displayName,
        kills: getCellNum(colK),
        deaths: getCellNum(colD),
        acs: getCellNum(colAcs),
        rating20: colRating >= 0 ? getCellNum(colRating) : 0,
        k4: 0, k5: 0, k6: 0, k7: 0,
        clutch1v2: 0, clutch1v3: 0, clutch1v4: 0, clutch1v5: 0,
        isWinner: isWinner,
        cleanSheetWin: isCleanWin,
      };
    }
  });

  return { stats, matchId: "", resultA, resultB };
}

function scrapePerformance(html: string, stats: Record<string, PlayerStats>): void {
  // Isolate the All Maps section — the FIRST mod-adv-stats inside it is the aggregate table
  const allHtml = extractAllMapsSection(html);
  if (!allHtml) return;

  const tag = "mod-adv-stats";
  const tagIdx = allHtml.toLowerCase().indexOf(tag);
  if (tagIdx < 0) return;

  const tableStart = allHtml.lastIndexOf("<table", tagIdx);
  const tableEnd = allHtml.indexOf("</table>", tagIdx);
  if (tableStart < 0 || tableEnd < 0) return;
  const table = allHtml.substring(tableStart, tableEnd + 8);

  // Parse header row (table has no <tbody> — just <tr> elements directly)
  const allRows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)];
  if (allRows.length < 2) return;

  const headers = [...allRows[0][0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map(h => h[1].replace(/<[^>]+>/g, "").trim().toLowerCase());

  const idx4k  = headers.indexOf("4k");
  const idx5k  = headers.indexOf("5k");
  const idx6k  = headers.indexOf("6k");
  const idx7k  = headers.indexOf("7k");
  const idx1v2 = headers.indexOf("1v2");
  const idx1v3 = headers.indexOf("1v3");
  const idx1v4 = headers.indexOf("1v4");
  const idx1v5 = headers.indexOf("1v5");

  // Parse player rows (skip first row = headers)
  for (const rowMatch of allRows.slice(1)) {
    const row = rowMatch[0];
    const cells = [...row.matchAll(/<td[\s\S]*?<\/td>/g)].map(c => c[0]);
    if (!cells.length) continue;

    // Player name: strip all tags, split on whitespace, first token is the IGN
    const nameTokens = cells[0].replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean);
    const nameRaw = nameTokens[0] ?? "";
    const nk = nameRaw.toLowerCase();
    if (!stats[nk]) continue;

    // Extract first number at start of stripped cell text (before round-detail noise)
    function perf(idx: number): number {
      if (idx < 0 || idx >= cells.length) return 0;
      const txt = cells[idx].replace(/<[^>]+>/g, " ").trim();
      const m = txt.match(/^(\d+)/);
      return m ? parseInt(m[1]) : 0;
    }

    if (idx4k  >= 0) stats[nk].k4       = perf(idx4k);
    if (idx5k  >= 0) stats[nk].k5       = perf(idx5k);
    if (idx6k  >= 0) stats[nk].k6       = perf(idx6k);
    if (idx7k  >= 0) stats[nk].k7       = perf(idx7k);
    if (idx1v2 >= 0) stats[nk].clutch1v2 = perf(idx1v2);
    if (idx1v3 >= 0) stats[nk].clutch1v3 = perf(idx1v3);
    if (idx1v4 >= 0) stats[nk].clutch1v4 = perf(idx1v4);
    if (idx1v5 >= 0) stats[nk].clutch1v5 = perf(idx1v5);
  }
}

// ── Main handler ─────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  try {
    const { match_url, matchday_id, tournament_id, fixture_id } = await req.json();
    if (!match_url || !matchday_id || !tournament_id) {
      return json({ error: "match_url, matchday_id, tournament_id are required" }, 400);
    }

    // Extract match ID from URL (e.g. vlr.gg/12345/team-a-vs-team-b → "12345")
    const matchId = match_url.replace(/^https?:\/\/(www\.)?vlr\.gg\//, "").split("/")[0];
    if (!matchId || isNaN(Number(matchId))) {
      return json({ error: `Could not extract match ID from URL: ${match_url}` }, 400);
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Check if already processed
    const { data: existing } = await sb.from("processed_matches").select("match_id").eq("match_id", matchId).single();
    if (existing) return json({ error: `Match ${matchId} already processed` }, 409);

    // Refuse if matchday scores are locked (market is open for next matchday)
    const { data: matchdayRow } = await sb.from("matchdays").select("scores_locked").eq("id", matchday_id).single();
    if (matchdayRow?.scores_locked) {
      return json({ error: `MD${matchday_id} scores are locked — market is open, cannot rescore` }, 423);
    }

    // Fetch VLR pages
    const baseUrl = `https://www.vlr.gg/${matchId}`;
    const [ovHtml, perfHtml] = await Promise.all([
      fetchVLR(`${baseUrl}/?game=all&tab=overview`),
      fetchVLR(`${baseUrl}/?game=all&tab=performance`),
    ]);

    // Parse
    const { stats, resultA, resultB } = scrapeOverview(ovHtml);
    if (!Object.keys(stats).length) return json({ error: "No player data found — match may not be finished" }, 422);
    scrapePerformance(perfHtml, stats);

    // Reject if all player stats are zero — match hasn't started yet
    const hasRealStats = Object.values(stats).some(p => p.kills > 0 || p.acs > 0 || p.rating20 > 0);
    if (!hasRealStats) return json({ error: "Match hasn't started yet — all player stats are zero" }, 422);

    // Rank by Rating 2.0
    const sorted = Object.entries(stats).sort((a, b) => b[1].rating20 - a[1].rating20);
    const ratingRank: Record<string, number> = {};
    sorted.forEach(([nk], i) => ratingRank[nk] = i + 1);
    const lowestNk = sorted[sorted.length - 1]?.[0] ?? "";

    // Store in match_player_cache
    const cacheRows = Object.entries(stats).map(([nk, d]) => ({
      match_id: matchId,
      tournament_id,
      matchday_id,
      player_name: d.displayName,
      kills: d.kills, deaths: d.deaths, acs: d.acs, rating_2_0: d.rating20,
      k4: d.k4, k5: d.k5, k6: d.k6, k7: d.k7,
      clutch_1v2: d.clutch1v2, clutch_1v3: d.clutch1v3,
      clutch_1v4: d.clutch1v4, clutch_1v5: d.clutch1v5,
      is_winner: d.isWinner, clean_sheet_win: d.cleanSheetWin,
      rating_rank: ratingRank[nk] ?? 99,
      is_lowest_rating: nk === lowestNk,
    }));
    await sb.from("match_player_cache").upsert(cacheRows, { onConflict: "match_id,player_name" });

    // Score all teams — load data in parallel with correct matchday filters
    const [
      { data: rosters },
      { data: allTeams },
      { data: chipsThisMD },
      { data: penaltyTransfers },
      { data: tournamentRow },
    ] = await Promise.all([
      sb.from("rosters").select("team_id, slot, player_id, players!inner(name)")
        .in("team_id",
          (await sb.from("teams").select("id").eq("tournament_id", tournament_id)).data?.map((t: any) => t.id) ?? []
        ),
      sb.from("teams").select("id, captain_id, captain2_id").eq("tournament_id", tournament_id),
      // Only chips activated for THIS matchday
      sb.from("active_chips").select("team_id, chip_name").eq("matchday_id", matchday_id),
      // Only transfers with penalty in THIS matchday
      sb.from("transfers").select("team_id").eq("matchday_id", matchday_id).eq("penalty_applied", true),
      sb.from("tournaments").select("transfer_penalty").eq("id", tournament_id).single(),
    ]);

    if (!rosters?.length) {
      await sb.from("processed_matches").insert({ match_id: matchId, tournament_id, matchday_id });
      return json({ ok: true, matchId, players: Object.keys(stats).length, teamsScored: 0 });
    }

    const transferPenaltyPts: number = tournamentRow?.transfer_penalty ?? 8;

    // Build lookup maps
    const captainMap: Record<string, { captainId: number | null; captain2Id: number | null }> = {};
    for (const t of (allTeams ?? [])) captainMap[t.id] = { captainId: t.captain_id, captain2Id: t.captain2_id };

    const chipMap: Record<string, string> = {};
    for (const c of (chipsThisMD ?? [])) chipMap[c.team_id] = c.chip_name;

    // Count penalty transfers per team
    const penaltyCount: Record<string, number> = {};
    for (const tr of (penaltyTransfers ?? [])) {
      penaltyCount[tr.team_id] = (penaltyCount[tr.team_id] ?? 0) + 1;
    }

    // Group roster slots by team
    const teamMap: Record<string, {
      captainId: number | null; captain2Id: number | null; chip: string | null;
      slots: { slot: string; playerId: number; playerName: string }[];
    }> = {};

    for (const row of (rosters ?? [])) {
      if (!teamMap[row.team_id]) {
        const caps = captainMap[row.team_id] ?? { captainId: null, captain2Id: null };
        teamMap[row.team_id] = {
          captainId: caps.captainId,
          captain2Id: caps.captain2Id,
          chip: chipMap[row.team_id] ?? null,
          slots: [],
        };
      }
      const playerName = (row as any).players?.name ?? "";
      if (playerName) {
        teamMap[row.team_id].slots.push({ slot: row.slot, playerId: row.player_id, playerName });
      }
    }

    const scoreLogs: any[] = [];
    const matchdayScores: Record<string, { raw: number; penalty: number }> = {};

    // Debug calc log — returned in response for inspection
    const calcLog: Record<string, any> = {
      lowestRatedPlayer: lowestNk,
      ratingRanks: ratingRank,
      playerRawStats: Object.fromEntries(Object.entries(stats).map(([nk, d]) => [nk, {
        kills: d.kills, deaths: d.deaths, acs: d.acs, rating20: d.rating20,
        k4: d.k4, k5: d.k5, k6: d.k6, k7: d.k7,
        clutch1v2: d.clutch1v2, clutch1v3: d.clutch1v3, clutch1v4: d.clutch1v4, clutch1v5: d.clutch1v5,
        isWinner: d.isWinner, cleanSheetWin: d.cleanSheetWin,
      }])),
      teams: {} as Record<string, any>,
    };

    console.log("[calcLog] lowestRatedPlayer:", lowestNk);
    console.log("[calcLog] ratingRanks:", JSON.stringify(ratingRank));

    for (const [teamId, team] of Object.entries(teamMap)) {
      let teamRaw = 0;

      calcLog.teams[teamId] = {
        chip: team.chip,
        captainId: team.captainId,
        captain2Id: team.captain2Id,
        players: [] as any[],
        teamTotal: 0,
        penaltyCount: 0,
        penaltyPts: 0,
        netPts: 0,
      };
      console.log(`\n[calcLog] ── Team ${teamId} | chip=${team.chip ?? "none"} cap=${team.captainId} cap2=${team.captain2Id} ──`);


      for (const { slot, playerId, playerName } of team.slots) {
        const nk = playerName.toLowerCase();
        const d = stats[nk];
        const rank = ratingRank[nk] ?? 99;
        const isLowest = nk === lowestNk;

        if (!d) {
          // Player didn't play this match — 0 pts
          console.log(`  [calcLog] ${playerName} (${slot}): NOT IN MATCH → 0 pts`);
          calcLog.teams[teamId].players.push({ playerName, slot, playerId, foundInMatch: false, finalPts: 0 });
          scoreLogs.push({
            team_id: teamId, matchday_id, match_id: matchId,
            player_id: playerId, player_name: playerName, slot,
            raw_pts: 0, final_pts: 0,
          });
          continue;
        }

        const isCaptain = team.captainId === playerId;
        const isCaptain2 = team.captain2Id === playerId;
        // topfragger: captain auto-assigned after matchday via rating — no captain bonus in regular scoring
        const isAnyCaptain = team.chip !== "topfragger" && (isCaptain || isCaptain2);

        let effectiveChip = team.chip;
        if (team.chip === "topfragger") effectiveChip = null; // handled separately

        const { rawPts, finalPts: baseFinal } = calculateScore(
          { kills: d.kills, k4: d.k4, k5: d.k5, k6: d.k6, k7: d.k7,
            clutch_1v2: d.clutch1v2, clutch_1v3: d.clutch1v3, clutch_1v4: d.clutch1v4, clutch_1v5: d.clutch1v5,
            is_winner: d.isWinner, clean_sheet_win: d.cleanSheetWin },
          rank, isLowest, isAnyCaptain, effectiveChip
        );

        const finalPts = baseFinal;
        teamRaw += finalPts;

        // Build and store per-player breakdown
        const bd = scoreBreakdown(
          { kills: d.kills, k4: d.k4, k5: d.k5, k6: d.k6, k7: d.k7,
            clutch_1v2: d.clutch1v2, clutch_1v3: d.clutch1v3, clutch_1v4: d.clutch1v4, clutch_1v5: d.clutch1v5,
            is_winner: d.isWinner, clean_sheet_win: d.cleanSheetWin },
          rank, isLowest, isAnyCaptain, effectiveChip
        );
        calcLog.teams[teamId].players.push({ playerName, slot, playerId, isCaptain: isAnyCaptain, ...bd });
        console.log(
          `  [calcLog] ${playerName} (${slot}${isAnyCaptain ? " ★CAP" : ""}):`,
          `kills=${d.kills}(${bd.killPts}pt)`,
          `4K=${d.k4}(${bd.k4pts}) 5K=${d.k5}(${bd.k5pts}) 6K=${d.k6}(${bd.k6pts}) 7K=${d.k7}(${bd.k7pts})`,
          `clutch=${bd.clutchTotal}(${bd.clutchPts}pt)`,
          `ratingRank=${rank}(${bd.ratingPts}pt)${isLowest ? " LOWEST(-3)" : ""}`,
          `win=${d.isWinner}(${bd.winPts}pt) cs=${d.cleanSheetWin}(${bd.cleanSheetPts}pt)`,
          `→ raw=${rawPts} ×${bd.captainMult} = final=${finalPts}`
        );

        scoreLogs.push({
          team_id: teamId, matchday_id, match_id: matchId,
          player_id: playerId, player_name: playerName, slot,
          kills: d.kills, deaths: d.deaths, acs: d.acs, rating_2_0: d.rating20,
          k4: d.k4, k5: d.k5, k6: d.k6, k7: d.k7,
          total_clutch: d.clutch1v2 + d.clutch1v3 + d.clutch1v4 + d.clutch1v5,
          is_winner: d.isWinner, clean_sheet_win: d.cleanSheetWin,
          rating_rank: rank, is_lowest_rating: isLowest,
          is_captain: isAnyCaptain,
          chip_used: team.chip,
          raw_pts: rawPts,
          final_pts: finalPts,
        });
      }

      // Transfer penalty: count penalty_applied transfers × penalty pts
      const penCount = penaltyCount[teamId] ?? 0;
      const penPts = penCount * transferPenaltyPts;
      matchdayScores[teamId] = { raw: teamRaw, penalty: penPts };

      calcLog.teams[teamId].teamTotal = teamRaw;
      calcLog.teams[teamId].penaltyCount = penCount;
      calcLog.teams[teamId].penaltyPts = penPts;
      calcLog.teams[teamId].netPts = teamRaw - penPts;
      console.log(`  [calcLog] Team ${teamId} total: raw=${teamRaw} penalty=${penPts}(×${penCount}) net=${teamRaw - penPts}`);
    }

    // Purge any previous score_logs for this match so re-runs replace rather than append
    await sb.from("score_logs").delete().eq("match_id", matchId);
    if (scoreLogs.length) {
      await sb.from("score_logs").insert(scoreLogs);
    }

    // Post-process topfragger chip: auto-assign ×2 to squad player with highest total raw_pts
    // across all matches in the matchday.
    for (const [teamId, team] of Object.entries(teamMap)) {
      if (team.chip !== "topfragger") continue;

      const { data: mdLogs } = await sb
        .from("score_logs")
        .select("id, player_id, raw_pts")
        .eq("team_id", teamId)
        .eq("matchday_id", matchday_id);

      if (!mdLogs || !mdLogs.length) continue;

      // Reset all final_pts to raw_pts first
      for (const log of mdLogs) {
        await sb.from("score_logs").update({ final_pts: log.raw_pts }).eq("id", log.id);
      }

      // Find player with highest total raw_pts across all their match rows
      const playerTotalPts: Record<number, number> = {};
      for (const log of mdLogs) {
        playerTotalPts[log.player_id] = (playerTotalPts[log.player_id] ?? 0) + (log.raw_pts ?? 0);
      }

      let topPts = -Infinity, topPlayerId = -1;
      for (const [pid, pts] of Object.entries(playerTotalPts)) {
        if (pts > topPts) { topPts = pts; topPlayerId = Number(pid); }
      }
      if (topPlayerId === -1) continue;

      // Apply ×2 to the top scorer's rows
      for (const log of mdLogs.filter(l => l.player_id === topPlayerId)) {
        await sb.from("score_logs").update({ final_pts: log.raw_pts * 2 }).eq("id", log.id);
      }

      console.log(`  [topfragger] Team ${teamId}: top scorer = player_id=${topPlayerId} raw_pts=${topPts}`);
    }

    // Recalculate matchday_scores by summing ALL score_logs for this matchday per team.
    // Never accumulate additively — that would double-count if the match is re-scored.
    for (const [teamId, { penalty }] of Object.entries(matchdayScores)) {
      const { data: allLogs } = await sb
        .from("score_logs")
        .select("final_pts")
        .eq("team_id", teamId)
        .eq("matchday_id", matchday_id);

      const totalRaw = (allLogs ?? []).reduce((s: number, r: any) => s + (r.final_pts ?? 0), 0);
      await sb.from("matchday_scores").upsert(
        { team_id: teamId, matchday_id, raw_points: totalRaw, penalty_points: penalty, net_points: totalRaw - penalty },
        { onConflict: "team_id,matchday_id" }
      );

      // Update teams.total_points
      const { data: allScores } = await sb
        .from("matchday_scores")
        .select("net_points")
        .eq("team_id", teamId);
      const total = (allScores ?? []).reduce((s: number, r: any) => s + (r.net_points ?? 0), 0);
      await sb.from("teams").update({ total_points: total }).eq("id", teamId);
    }

    // Mark match as processed (link to fixture if provided)
    await sb.from("processed_matches").upsert({ match_id: matchId, tournament_id, matchday_id, fixture_id: fixture_id ?? null }, { onConflict: "match_id" });

    // Mark fixture as completed and store actual result
    if (fixture_id) {
      await sb.from("fixtures").update({
        status: "completed",
        vlr_match_url: match_url,
        result_a: resultA,
        result_b: resultB,
      }).eq("id", fixture_id);

      // Evaluate predictions for this fixture
      const { data: fixturePreds } = await sb
        .from("predictions")
        .select("id, score_a, score_b, is_doubled")
        .eq("fixture_id", fixture_id);

      for (const pred of (fixturePreds ?? [])) {
        let pts = 0;

        // Base: exact score = 3, correct winner = 1, wrong = 0
        if (pred.score_a === resultA && pred.score_b === resultB) {
          pts = 3;
        } else if (
          (pred.score_a > pred.score_b && resultA > resultB) ||
          (pred.score_b > pred.score_a && resultB > resultA)
        ) {
          pts = 1;
        }

        // Sub-scoring: +1 for each team's exact map count predicted correctly
        if (pred.score_a === resultA) pts += 1;
        if (pred.score_b === resultB) pts += 1;

        // x2 multiplies the full total
        if (pred.is_doubled) pts *= 2;

        await sb.from("predictions").update({ points_earned: pts }).eq("id", pred.id);
      }
    }

    return json({
      ok: true,
      matchId,
      players: Object.keys(stats).length,
      teamsScored: Object.keys(matchdayScores).length,
      result_a: resultA,
      result_b: resultB,
      calcLog,
    });

  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
