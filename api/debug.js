// /api/debug.js
// Endpoint temporal SOLO para diagnóstico. Bórralo después de resolver el problema.

export default async function handler(req, res) {
  const sportsKey = process.env.SPORTS_API_KEY || "";
  const headers = { "x-apisports-key": sportsKey };

  try {
    // 1. Buscar la liga "World Cup" para confirmar el ID correcto
    const leaguesRes = await fetch(
      "https://v3.football.api-sports.io/leagues?search=World Cup",
      { headers }
    ).then((r) => r.json());

    // 2. Probar fixtures con league=1 season=2026 (lo que usa picks.js)
    const fixturesRes = await fetch(
      "https://v3.football.api-sports.io/fixtures?league=1&season=2026",
      { headers }
    ).then((r) => r.json());

    res.status(200).json({
      leagues_search_results: leaguesRes.results,
      leagues_found: (leaguesRes.response || []).map((l) => ({
        id: l.league.id,
        name: l.league.name,
        type: l.league.type,
        seasons: (l.seasons || []).map((s) => s.year),
      })),
      fixtures_league1_season2026: {
        results: fixturesRes.results,
        errors: fixturesRes.errors,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
