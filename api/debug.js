// /api/debug.js
// Endpoint temporal SOLO para diagnóstico. Bórralo después de resolver el problema.

export default async function handler(req, res) {
  const sportsKey = process.env.SPORTS_API_KEY || "";

  try {
    const apiRes = await fetch("https://v3.football.api-sports.io/status", {
      headers: {
        "x-apisports-key": sportsKey,
      },
    });

    const data = await apiRes.json();

    res.status(200).json({
      sports_key_length: sportsKey.length,
      sports_key_preview: sportsKey ? `${sportsKey.slice(0, 4)}...${sportsKey.slice(-4)}` : null,
      http_status: apiRes.status,
      api_response: data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
