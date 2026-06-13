// /api/picks.js
// Función serverless (Vercel). Se ejecuta en el servidor, nunca en el navegador.
//
// Flujo:
// 1. Llama a API-Football para traer partidos de hoy y mañana (Mundial 2026, league id 1).
// 2. Para cada partido, trae forma reciente de ambos equipos.
// 3. Construye un prompt con todo eso y se lo manda a Claude.
// 4. Claude devuelve un JSON con picks + razonamiento, en el mismo formato que el frontend espera.
// 5. Devolvemos ese JSON al frontend.

export default async function handler(req, res) {
  const SPORTS_API_KEY = process.env.SPORTS_API_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SPORTS_API_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "Faltan API keys en las variables de entorno (SPORTS_API_KEY / ANTHROPIC_API_KEY)."
    });
  }

  try {
    // ---------- 1. Traer partidos (hoy + mañana) ----------
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const fmt = (d) => d.toISOString().split("T")[0];

    const fixturesRes = await Promise.all(
      [today, tomorrow].map((d) =>
        fetch(
          `https://v3.football.api-sports.io/fixtures?date=${fmt(d)}&league=1&season=2026`,
          {
            headers: {
              "x-apisports-key": SPORTS_API_KEY,
            },
          }
        ).then((r) => r.json())
      )
    );

    const fixtures = fixturesRes.flatMap((r) => r.response || []);

    if (fixtures.length === 0) {
      return res.status(200).json({ picks: [], message: "No hay partidos programados para hoy/mañana." });
    }

    // Limitar a un número razonable para no gastar de más en la API de Claude
    const limited = fixtures.slice(0, 8);

    // ---------- 2. Traer forma reciente de cada equipo ----------
    const matchesData = await Promise.all(
      limited.map(async (fx) => {
        const homeId = fx.teams.home.id;
        const awayId = fx.teams.away.id;

        const [homeForm, awayForm] = await Promise.all(
          [homeId, awayId].map((id) =>
            fetch(
              `https://v3.football.api-sports.io/fixtures?team=${id}&last=5`,
              { headers: { "x-apisports-key": SPORTS_API_KEY } }
            )
              .then((r) => r.json())
              .catch(() => ({ response: [] }))
          )
        );

        return {
          fixture_id: fx.fixture.id,
          date: fx.fixture.date,
          venue: fx.fixture.venue?.name || "",
          home: fx.teams.home.name,
          away: fx.teams.away.name,
          home_last5: (homeForm.response || []).map(summarizeResult(homeId)),
          away_last5: (awayForm.response || []).map(summarizeResult(awayId)),
        };
      })
    );

    // ---------- 3. Construir prompt para Claude ----------
    const prompt = buildPrompt(matchesData);

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();

    if (!claudeData.content) {
      return res.status(500).json({ error: "Respuesta inválida de Claude", raw: claudeData });
    }

    const text = claudeData.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    const clean = text.replace(/```json|```/g, "").trim();

    let picks;
    try {
      picks = JSON.parse(clean);
    } catch (e) {
      return res.status(500).json({ error: "No se pudo parsear la respuesta de Claude", raw: text });
    }

    return res.status(200).json({ picks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Resume un resultado pasado desde la perspectiva del equipo `teamId`
function summarizeResult(teamId) {
  return (fx) => {
    const isHome = fx.teams.home.id === teamId;
    const goalsFor = isHome ? fx.goals.home : fx.goals.away;
    const goalsAgainst = isHome ? fx.goals.away : fx.goals.home;
    const opponent = isHome ? fx.teams.away.name : fx.teams.home.name;

    let result = "E";
    if (goalsFor > goalsAgainst) result = "G";
    if (goalsFor < goalsAgainst) result = "P";

    return {
      vs: opponent,
      local: isHome,
      resultado: result,
      marcador: `${goalsFor}-${goalsAgainst}`,
    };
  };
}

function buildPrompt(matches) {
  return `Eres un analista deportivo. Te paso datos reales de partidos del Mundial 2026 (próximas 48h) con la forma reciente (últimos 5 partidos) de cada selección.

Para cada partido, propone 1-2 "picks" (mercados de apuesta) con:
- market: nombre del mercado (ej "Doble oportunidad", "Over/Under goles", "Ambos anotan")
- selection: la selección concreta del pick
- odds_estimate: una cuota estimada razonable (string, ej "1.35") - deja claro que es una ESTIMACIÓN, no cuota real de casa de apuestas
- confidence: número 15-92 (nunca 100, nunca menor a 15) que representa cuántas señales de contexto respaldan el pick
- reasons: array de 2-4 strings, cada uno explicando una razón concreta basada en los datos de forma reciente que tienes (ej "Ganó 4 de sus últimos 5 partidos como local")
- risk: un string explicando el principal riesgo/razón por la que el pick podría fallar

Reglas:
- Basa el razonamiento SOLO en los datos de forma reciente proporcionados. No inventes lesiones, alineaciones ni datos que no tengas.
- Si no hay suficiente data de forma (selecciones que no jugaron amistosos recientes), dilo en "reasons" y baja la confianza.
- Sé honesto: ningún pick es 100% seguro.

Datos de los partidos:
${JSON.stringify(matches, null, 2)}

Responde ÚNICAMENTE con un JSON válido, sin texto adicional, con esta forma exacta:
{
  "picks": [
    {
      "match": "Equipo A vs Equipo B",
      "meta": "Fecha · Hora · Sede",
      "confidence": 65,
      "selections": [
        {
          "market": "...",
          "selection": "...",
          "odds_estimate": "1.40"
        }
      ],
      "reasons": ["...", "..."],
      "risk": "..."
    }
  ]
}`;
}
