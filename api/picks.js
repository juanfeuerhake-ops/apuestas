// /api/picks.js
import fs from "fs";
import path from "path";

let cachedMundial = null;
let cacheMundialTimestamp = 0;
const CACHE_MUNDIAL_TTL_MS = 24 * 60 * 60 * 1000;

let cachedUFC = null;
let cacheUFCTimestamp = 0;
const CACHE_UFC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_UFC_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY) return res.status(500).json({ error: "Falta GROQ_UFC_KEY en variables de entorno." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY en variables de entorno." });

  const now = Date.now();
  let mundialPicks = null;
  let ufcPicks = null;
  let mundialError = null;
  let ufcError = null;

  // ═══════════════════════════════════════
  // BLOQUE 1: MUNDIAL — ESPN + Groq
  // ═══════════════════════════════════════
  try {
    if (cachedMundial && (now - cacheMundialTimestamp) < CACHE_MUNDIAL_TTL_MS) {
      mundialPicks = cachedMundial;
    } else {
      const matches = await fetchESPNMatches();

      if (matches.length === 0) {
        mundialPicks = { picks: [], message: "No hay partidos del Mundial programados para hoy o mañana." };
      } else {
        const prompt = buildMundialPrompt(matches);
        const text = await callGroq(GROQ_KEY, prompt);
        const analysesArray = extractArray(text);

        if (analysesArray && analysesArray.length > 0) {
          mundialPicks = { picks: analysesArray, updated: new Date().toISOString().split("T")[0] };
          cachedMundial = mundialPicks;
          cacheMundialTimestamp = now;
        } else {
          mundialPicks = { picks: [], message: "La IA no pudo generar análisis. Intenta de nuevo en unos minutos." };
        }
      }
    }
  } catch (err) {
    console.error("Error MUNDIAL:", err);
    mundialError = String(err?.message || err || "Error desconocido en Mundial");
    mundialPicks = { picks: [], message: `Error: ${mundialError}` };
  }

  // ═══════════════════════════════════════
  // BLOQUE 2: UFC — Gemini
  // ═══════════════════════════════════════
  try {
    if (cachedUFC && (now - cacheUFCTimestamp) < CACHE_UFC_TTL_MS) {
      ufcPicks = cachedUFC;
    } else {
      const ufcPrompt = buildUFCPrompt();
      const ufcText = await callGemini(GEMINI_KEY, ufcPrompt);
      const ufcArray = extractArray(ufcText);

      if (ufcArray && ufcArray.length > 0) {
        ufcPicks = { fights: ufcArray };
        cachedUFC = ufcPicks;
        cacheUFCTimestamp = now;
      } else {
        ufcPicks = { fights: [], message: "No se pudo obtener el cartel de UFC esta semana." };
      }
    }
  } catch (err) {
    console.error("Error UFC:", err);
    ufcError = String(err?.message || err || "Error desconocido en UFC");
    ufcPicks = { fights: [], message: `Error: ${ufcError}` };
  }

  // Siempre devuelve 200 con lo que haya — los errores van dentro del objeto
  return res.status(200).json({
    mundial: mundialPicks,
    ufc: ufcPicks,
    _debug: {
      mundialError: mundialError || null,
      ufcError: ufcError || null,
      timestamp: new Date().toISOString(),
    }
  });
}

// ─── ESPN ─────────────────────────────────────────────────────────────────────
async function fetchESPNMatches() {
  const getDates = () => {
    const offset = -6;
    const d = new Date(new Date().getTime() + offset * 3600 * 1000);
    const fmt = (dateObj) => {
      const y = dateObj.getUTCFullYear();
      const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
      const day = String(dateObj.getUTCDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };
    return [fmt(d), fmt(new Date(d.getTime() + 24 * 3600 * 1000))];
  };

  const [today, tomorrow] = getDates();
  const matches = [];

  for (const date of [today, tomorrow]) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`;
      const espnRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!espnRes.ok) {
        console.warn(`ESPN HTTP ${espnRes.status} para fecha ${date}`);
        continue;
      }

      const data = await espnRes.json();
      const events = data.events || [];

      for (const event of events) {
        const competition = event.competitions?.[0];
        if (!competition) continue;

        const competitors = competition.competitors || [];
        const home = competitors.find(c => c.homeAway === "home");
        const away = competitors.find(c => c.homeAway === "away");
        if (!home || !away) continue;

        const homeName = home.team?.displayName || home.team?.name || "Local";
        const awayName = away.team?.displayName || away.team?.name || "Visitante";
        const dateStr = event.date ? new Date(event.date).toISOString().split("T")[0] : date;
        const venue = [competition.venue?.fullName, competition.venue?.address?.city].filter(Boolean).join(", ");
        const notes = competition.notes?.[0]?.headline || event.name || "";
        const homeRecord = home.records?.[0]?.summary || "";
        const awayRecord = away.records?.[0]?.summary || "";

        matches.push({
          match: `${homeName} vs ${awayName}`,
          home: homeName,
          away: awayName,
          date: dateStr,
          venue,
          round: notes,
          home_record: homeRecord,
          away_record: awayRecord,
        });
      }
    } catch (err) {
      console.warn(`ESPN error para ${date}:`, err.message);
    }
  }

  // Fallback a fixtures.json si ESPN no devuelve nada
  if (matches.length === 0) {
    try {
      const fixturesPath = path.join(process.cwd(), "fixtures.json");
      const raw = fs.readFileSync(fixturesPath, "utf-8");
      const fixtureData = JSON.parse(raw);
      const offset = -6;
      const d = new Date(new Date().getTime() + offset * 3600 * 1000);
      const pad = n => String(n).padStart(2, "0");
      const fmt = dateObj => `${dateObj.getUTCFullYear()}-${pad(dateObj.getUTCMonth()+1)}-${pad(dateObj.getUTCDate())}`;
      const todayStr = fmt(d);
      const tomorrowStr = fmt(new Date(d.getTime() + 24 * 3600 * 1000));
      return (fixtureData.matches || []).filter(m => m.date === todayStr || m.date === tomorrowStr);
    } catch {
      return [];
    }
  }

  return matches;
}

// ─── Groq ─────────────────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama3-8b-8192",
      messages: [
        {
          role: "system",
          content: "Eres un analista profesional de apuestas deportivas. Responde SIEMPRE con JSON válido y nada más. Sin markdown, sin texto antes o después del JSON."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Groq devolvió respuesta vacía");
  return text;
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") console.warn("Gemini finishReason:", finishReason);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error(`Gemini devolvió texto vacío. FinishReason: ${finishReason}`);
  return text;
}

// ─── Extraer array JSON ───────────────────────────────────────────────────────
function extractArray(text) {
  let clean = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  const firstBracket = clean.indexOf("[");
  const lastBracket = clean.lastIndexOf("]");

  if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  } else if (firstBracket !== -1 && lastBracket !== -1) {
    clean = clean.substring(firstBracket, lastBracket + 1);
  }

  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.analyses)) return parsed.analyses;
    if (Array.isArray(parsed.fights)) return parsed.fights;
    if (Array.isArray(parsed.picks)) return parsed.picks;
    if (Array.isArray(parsed.predictions)) return parsed.predictions;
    console.error("JSON sin array reconocido:", JSON.stringify(parsed).substring(0, 200));
    return null;
  } catch (e) {
    console.error("Error al parsear JSON:", e.message, "\nTexto:", text.substring(0, 400));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches) {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de apuestas de fútbol. Hoy es ${today}.

Analiza estos partidos del Mundial 2026 y entrega EXACTAMENTE 3 picks por partido en mercados DISTINTOS. NO uses solo "quién gana". Prioriza mercados con valor analítico real.

MERCADOS (elige los 3 con más respaldo para cada partido):
- Handicap asiático
- Total de goles Over/Under
- Resultado al descanso
- Primer tiempo Over/Under
- Ambos equipos anotan Sí/No
- Corners Over/Under
- Tarjetas Over/Under
- Ganador (solo si hay ventaja táctica muy clara)

Partidos:
${JSON.stringify(matches, null, 2)}

Devuelve SOLO JSON válido:
{"analyses":[{"match":"A vs B","meta":"Fecha · Sede · Ronda","context":"contexto clave en 1 oración","picks":[{"market":"mercado","selection":"apuesta exacta","odds_estimate":"1.75","confidence":74,"reasoning":"2-3 oraciones con respaldo táctico específico","edge":"ventaja analítica en 1 frase"},{"market":"segundo mercado","selection":"apuesta","odds_estimate":"1.90","confidence":68,"reasoning":"razonamiento","edge":"edge"},{"market":"tercer mercado","selection":"apuesta","odds_estimate":"2.10","confidence":63,"reasoning":"razonamiento","edge":"edge"}],"risk":"riesgo principal en 1 oración"}]}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de MMA y apuestas. Hoy es ${today}.

Busca el cartel de UFC más próximo (este fin de semana o próximos 7 días). Para el main event y 3-4 peleas importantes, entrega EXACTAMENTE 3 picks por pelea en mercados DISTINTOS.

MERCADOS (elige los 3 con más respaldo):
- Método de victoria: KO/TKO, Sumisión, Decisión unánime, Decisión dividida
- Over/Under de rounds
- Llega al round X Sí/No
- Pelea va a distancia Sí/No
- Ganador por decisión
- Knockdown en la pelea Sí/No

Devuelve SOLO JSON válido:
{"fights":[{"fight":"A vs B","title":null,"weight_class":"división","event":"UFC XXX","date":"YYYY-MM-DD","venue":"Sede, Ciudad","context":"contexto en 1 oración","picks":[{"market":"mercado","selection":"apuesta exacta","odds_estimate":"1.85","confidence":76,"reasoning":"2-3 oraciones con métricas reales","edge":"ventaja analítica en 1 frase"},{"market":"segundo mercado","selection":"apuesta","odds_estimate":"1.65","confidence":71,"reasoning":"razonamiento","edge":"edge"},{"market":"tercer mercado","selection":"apuesta","odds_estimate":"2.20","confidence":65,"reasoning":"razonamiento","edge":"edge"}],"risk":"riesgo principal en 1 oración"}]}`;
}
