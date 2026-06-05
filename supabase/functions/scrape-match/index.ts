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

function scrapeOverview(html: string): { stats: Record<string, PlayerStats>; matchId: string; resultA: number; resultB: number } {
  // Find series score for winner / clean sheet
  let winnerTeamIdx = -1;
  let cleanSheet = false;
  let resultA = 0, resultB = 0;
  const scoreMatch = html.match(/match-header-vs-score[\s\S]*?(\d+)\s*:\s*(\d+)/);
  if (scoreMatch) {
    const s1 = parseInt(scoreMatch[1]), s2 = parseInt(scoreMatch[2]);
    resultA = s1; resultB = s2;
    if (s1 > s2) { winnerTeamIdx = 0; cleanSheet = s2 === 0; }
    else if (s2 > s1) { winnerTeamIdx = 1; cleanSheet = s1 === 0; }
  }

  // Parse all wf-table-inset mod-overview tables (one per team)
  const stats: Record<string, PlayerStats> = {};
  const tableRegex = /<table[^>]*class="[^"]*wf-table-inset mod-overview[^"]*"[\s\S]*?<\/table>/g;
  const tables = [...html.matchAll(tableRegex)];

  // Only keep tables that contain actual game data (data-game-id="all" section)
  // We look at the last two matching tables (one per team) from the all-maps section
  const gameTables = tables.filter(m => m[0].includes("text-of"));
  const teamTables = gameTables.slice(-2); // last two = all-maps aggregated

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
  // Find the LAST mod-adv-stats table — that's the all-maps aggregate
  const tag = "mod-adv-stats";
  const lower = html.toLowerCase();
  let lastTagIdx = -1;
  let si = 0;
  while (si < lower.length) {
    const i = lower.indexOf(tag, si);
    if (i < 0) break;
    lastTagIdx = i;
    si = i + 1;
  }
  if (lastTagIdx < 0) return;

  const tableStart = html.lastIndexOf("<table", lastTagIdx);
  const tableEnd = html.indexOf("</table>", lastTagIdx);
  if (tableStart < 0 || tableEnd < 0) return;
  const table = html.substring(tableStart, tableEnd + 8);

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

    for (const [teamId, team] of Object.entries(teamMap)) {
      let teamRaw = 0;

      // top_fragger: find highest raw scorer first (pass 1)
      let topFraggerBestPts = -Infinity;
      let topFraggerBestName = "";

      if (team.chip === "topfragger") {
        for (const { playerName } of team.slots) {
          const nk = playerName.toLowerCase();
          const d = stats[nk];
          if (!d) continue;
          const { rawPts } = calculateScore(
            { kills: d.kills, k4: d.k4, k5: d.k5, k6: d.k6, k7: d.k7,
              clutch_1v2: d.clutch1v2, clutch_1v3: d.clutch1v3, clutch_1v4: d.clutch1v4, clutch_1v5: d.clutch1v5,
              is_winner: d.isWinner, clean_sheet_win: d.cleanSheetWin },
            ratingRank[nk] ?? 99, nk === lowestNk, false, null
          );
          if (rawPts > topFraggerBestPts) { topFraggerBestPts = rawPts; topFraggerBestName = nk; }
        }
      }

      for (const { slot, playerId, playerName } of team.slots) {
        const nk = playerName.toLowerCase();
        const d = stats[nk];
        const rank = ratingRank[nk] ?? 99;
        const isLowest = nk === lowestNk;

        if (!d) {
          // Player didn't play this match — 0 pts
          scoreLogs.push({
            team_id: teamId, matchday_id, match_id: matchId,
            player_id: playerId, player_name: playerName, slot,
            raw_pts: 0, final_pts: 0,
          });
          continue;
        }

        const isCaptain = team.captainId === playerId;
        const isCaptain2 = team.captain2Id === playerId;
        const isAnyCaptain = isCaptain || isCaptain2;

        let effectiveChip = team.chip;
        if (team.chip === "topfragger") effectiveChip = null; // handled separately

        const { rawPts, finalPts: baseFinal } = calculateScore(
          { kills: d.kills, k4: d.k4, k5: d.k5, k6: d.k6, k7: d.k7,
            clutch_1v2: d.clutch1v2, clutch_1v3: d.clutch1v3, clutch_1v4: d.clutch1v4, clutch_1v5: d.clutch1v5,
            is_winner: d.isWinner, clean_sheet_win: d.cleanSheetWin },
          rank, isLowest, isAnyCaptain, effectiveChip
        );

        let finalPts = baseFinal;

        // top_fragger pass 2: double the best scorer
        if (team.chip === "topfragger" && nk === topFraggerBestName) {
          finalPts = rawPts * 2;
        }

        teamRaw += finalPts;

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
    }

    // Upsert score_logs
    if (scoreLogs.length) {
      await sb.from("score_logs").insert(scoreLogs);
    }

    // Upsert matchday_scores (accumulate — add to existing net_points)
    for (const [teamId, { raw, penalty }] of Object.entries(matchdayScores)) {
      const { data: existing } = await sb
        .from("matchday_scores")
        .select("raw_points, penalty_points")
        .eq("team_id", teamId)
        .eq("matchday_id", matchday_id)
        .single();

      const newRaw = (existing?.raw_points ?? 0) + raw;
      const newPenalty = existing?.penalty_points ?? penalty;
      await sb.from("matchday_scores").upsert(
        { team_id: teamId, matchday_id, raw_points: newRaw, penalty_points: newPenalty, net_points: newRaw - newPenalty },
        { onConflict: "team_id,matchday_id" }
      );

      // Update teams.total_points
      const { data: allScores } = await sb
        .from("matchday_scores")
        .select("net_points")
        .eq("team_id", teamId);
      const total = (allScores ?? []).reduce((s, r) => s + (r.net_points ?? 0), 0);
      await sb.from("teams").update({ total_points: total }).eq("id", teamId);
    }

    // Mark match as processed (link to fixture if provided)
    await sb.from("processed_matches").insert({ match_id: matchId, tournament_id, matchday_id, fixture_id: fixture_id ?? null });

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
        if (pred.score_a === resultA && pred.score_b === resultB) {
          pts = 3; // exact score
        } else if (
          (pred.score_a > pred.score_b && resultA > resultB) ||
          (pred.score_b > pred.score_a && resultB > resultA)
        ) {
          pts = 1; // correct winner
        }
        if (pred.is_doubled) pts *= 2;
        await sb.from("predictions").update({ points_earned: pts }).eq("id", pred.id);
      }
    }

    return json({
      ok: true,
      matchId,
      players: Object.keys(stats).length,
      teamsScored: Object.keys(matchdayScores).length,
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
