// /api/picks.js
import fs from "fs";
import path from "path";

// ---------- Caché en memoria ----------
let cachedMundial = null;
let cacheMundialTimestamp = 0;
const CACHE_MUNDIAL_TTL_MS = 24 * 60 * 60 * 1000;

let cachedUFC = null;
let cacheUFCTimestamp = 0;
const CACHE_UFC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_UFC_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY) return res.status(500).json({ error: "Falta GROQ_UFC_KEY." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY." });

  try {
    const now = Date.now();

    // ═══════════════════════════════════════
    // BLOQUE 1: MUNDIAL — ESPN + Groq
    // ═══════════════════════════════════════
    let mundialPicks = null;

    if (cachedMundial && (now - cacheMundialTimestamp) < CACHE_MUNDIAL_TTL_MS) {
      mundialPicks = cachedMundial;
    } else {
      // 1a. Obtener partidos de ESPN (hoy + mañana)
      const matches = await fetchESPNMatches();

      if (matches.length === 0) {
        mundialPicks = { picks: [], message: "No hay partidos del Mundial programados para hoy o mañana según ESPN." };
      } else {
        // 1b. Analizar con Groq
        const prompt = buildMundialPrompt(matches);
        const text = await callGroq(GROQ_KEY, prompt);
        const analysesArray = extractArray(text);

        if (analysesArray) {
          mundialPicks = { picks: analysesArray, updated: new Date().toISOString().split("T")[0] };
          cachedMundial = mundialPicks;
          cacheMundialTimestamp = now;
        } else {
          mundialPicks = { picks: [], message: "No se pudo analizar los partidos. Intenta de nuevo." };
        }
      }
    }

    // ═══════════════════════════════════════
    // BLOQUE 2: UFC — Gemini (sin grounding)
    // ═══════════════════════════════════════
    let ufcPicks = null;

    if (cachedUFC && (now - cacheUFCTimestamp) < CACHE_UFC_TTL_MS) {
      ufcPicks = cachedUFC;
    } else {
      const ufcPrompt = buildUFCPrompt();
      // FIX: sin responseMimeType ni grounding — los dos juntos rompen Gemini
      const ufcText = await callGemini(GEMINI_KEY, ufcPrompt);
      const ufcArray = extractArray(ufcText);

      if (ufcArray && ufcArray.length > 0) {
        ufcPicks = { fights: ufcArray };
        cachedUFC = ufcPicks;
        cacheUFCTimestamp = now;
      } else {
        ufcPicks = { fights: [], message: "No se pudo obtener el cartel de UFC de esta semana." };
      }
    }

    return res.status(200).json({ mundial: mundialPicks, ufc: ufcPicks });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── ESPN: partidos Mundial hoy + mañana ─────────────────────────────────────
async function fetchESPNMatches() {
  try {
    // Fechas en formato YYYYMMDD para ESPN
    const getDates = () => {
      const offset = -6; // UTC-6 México
      const d = new Date(new Date().getTime() + offset * 3600 * 1000);
      const fmt = (dateObj) => {
        const y = dateObj.getUTCFullYear();
        const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
        const day = String(dateObj.getUTCDate()).padStart(2, "0");
        return `${y}${m}${day}`;
      };
      const today = fmt(d);
      const tomorrow = fmt(new Date(d.getTime() + 24 * 3600 * 1000));
      return [today, tomorrow];
    };

    const [today, tomorrow] = getDates();
    const matches = [];

    for (const date of [today, tomorrow]) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`;
      const espnRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!espnRes.ok) continue;

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

        // Fecha y hora legible
        const dateStr = event.date ? new Date(event.date).toISOString().split("T")[0] : date;
        const timeUTC = event.date ? new Date(event.date).toUTCString().slice(17, 22) + " UTC" : "";

        // Venue
        const venue = competition.venue?.fullName || "";
        const city = competition.venue?.address?.city || "";
        const venueStr = [venue, city].filter(Boolean).join(", ");

        // Grupo/ronda
        const groupName = event.season?.slug || competition.series?.name || event.name || "";
        const notes = competition.notes?.[0]?.headline || "";

        // Forma reciente si ESPN la provee
        const homeRecord = home.records?.[0]?.summary || "";
        const awayRecord = away.records?.[0]?.summary || "";

        matches.push({
          match: `${homeName} vs ${awayName}`,
          home: homeName,
          away: awayName,
          date: dateStr,
          time: timeUTC,
          venue: venueStr,
          round: notes || groupName,
          home_record: homeRecord,
          away_record: awayRecord,
        });
      }
    }

    return matches;
  } catch (err) {
    console.error("Error ESPN:", err.message);
    // Fallback a fixtures.json si ESPN falla
    try {
      const fixturesPath = path.join(process.cwd(), "fixtures.json");
      const raw = fs.readFileSync(fixturesPath, "utf-8");
      const fixtureData = JSON.parse(raw);
      return fixtureData.matches || [];
    } catch {
      return [];
    }
  }
}

// ─── Groq (Mundial) ──────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Respuesta vacía de Groq");
  return text;
}

// ─── Gemini (UFC) — SIN responseMimeType ─────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          // SIN responseMimeType — era lo que rompía la respuesta de UFC
        },
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
    const err = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.warn("Gemini finishReason:", finishReason);
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Respuesta vacía de Gemini");
  return text;
}

// ─── Extraer array JSON ───────────────────────────────────────────────────────
function extractArray(text) {
  let clean = text.trim().replace(/^```json\n?/,"").replace(/\n?```$/,"");

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
    return null;
  } catch (e) {
    console.error("Error al parsear JSON:", e.message, "\nTexto:", text.substring(0, 300));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches) {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un scout profesional de fútbol y analista de apuestas deportivas de élite. Hoy es ${today}.

Analiza cada partido del Mundial 2026 que te proporciono y entrega EXACTAMENTE 3 picks por partido en mercados DISTINTOS. 

REGLAS CLAVE:
- NO uses solo "quién gana" como único pick. Explora mercados alternativos con fundamento real.
- Los mejores picks tienen valor analítico: no son los obvios, tienen respaldo táctico/estadístico específico.
- Prioriza picks con alta certeza analítica sobre picks arriesgados.
- Cada pick debe tener su propio razonamiento específico, no genérico.

MERCADOS DISPONIBLES (elige los 3 con más respaldo para cada partido):
- Handicap asiático (ej: "Equipo A -0.5", "Equipo B +1.5")
- Total de goles Over/Under (ej: "Menos de 2.5 goles")
- Resultado al descanso (ej: "Empate al HT")
- Primer tiempo Over/Under goles
- Ambos equipos anotan: Sí/No
- Corners Over/Under (si hay datos de estilo de juego)
- Tarjetas Over/Under (partidos físicos o de alta presión)
- Doble resultado (HT/FT)
- Ganador del partido (solo si hay ventaja táctica muy clara y cuota con valor)

Partidos a analizar:
${JSON.stringify(matches, null, 2)}

Devuelve SOLO este JSON sin texto adicional ni markdown:
{
  "analyses": [
    {
      "match": "Equipo A vs Equipo B",
      "meta": "Fecha · Sede · Ronda",
      "context": "1 oración sobre el contexto clave: qué se juega cada equipo, forma reciente, presión del partido",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta y clara",
          "odds_estimate": "1.75",
          "confidence": 74,
          "reasoning": "2-3 oraciones explicando qué patrón táctico, estadístico o situacional respalda específicamente este pick",
          "edge": "1 frase: la ventaja analítica que el mercado masivo suele ignorar"
        },
        {
          "market": "Segundo mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "1.90",
          "confidence": 68,
          "reasoning": "Razonamiento específico para este pick",
          "edge": "Edge analítico específico"
        },
        {
          "market": "Tercer mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "2.10",
          "confidence": 63,
          "reasoning": "Razonamiento específico para este pick",
          "edge": "Edge analítico específico"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks en 1 oración"
    }
  ]
}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de MMA y apuestas deportivas con conocimiento profundo de métricas avanzadas de peleadores (striking accuracy, takedown defense, significant strikes absorbed por minuto, etc.). Hoy es ${today}.

Busca el cartel de UFC más próximo de este fin de semana o los próximos 7 días. Para el main event y las 3-4 peleas más importantes, entrega EXACTAMENTE 3 picks por pelea en mercados DISTINTOS.

REGLAS CLAVE:
- NO uses solo "quién gana" como único pick. Los mejores picks en MMA están en mercados alternativos.
- Prioriza picks con alta certeza analítica: método de victoria específico, duración de pelea, etc.
- Cada pick debe tener razonamiento con métricas o tendencias reales del peleador.
- Prioriza seguridad analítica sobre cuotas altas.

MERCADOS DISPONIBLES (elige los 3 con más respaldo para cada pelea):
- Método de victoria: KO/TKO, Sumisión, Decisión unánime, Decisión dividida
- Over/Under de rounds (ej: "Menos de 1.5 rounds", "Más de 2.5 rounds")
- Llega al round X: Sí/No
- Pelea va a distancia (completa los rounds): Sí/No
- Ganador por decisión (cuando ambos tienen chin sólido y estilo defensivo)
- Parlay método + resultado (cuando hay alta certeza en ambos)
- Knockdown en la pelea: Sí/No (si hay diferencia clara en poder de golpeo)

Devuelve SOLO este JSON sin texto adicional ni markdown:
{
  "fights": [
    {
      "fight": "Peleador A vs Peleador B",
      "title": "Cinturón en juego o null",
      "weight_class": "División en español",
      "event": "Nombre del evento UFC",
      "date": "YYYY-MM-DD",
      "venue": "Sede, Ciudad",
      "context": "1 oración sobre el contexto: récords actuales, narrativa, forma reciente",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta y clara",
          "odds_estimate": "1.85",
          "confidence": 76,
          "reasoning": "2-3 oraciones con métricas o tendencias reales que respaldan este pick específicamente",
          "edge": "1 frase: la ventaja analítica que otros apostadores suelen perder de vista"
        },
        {
          "market": "Segundo mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "1.65",
          "confidence": 71,
          "reasoning": "Razonamiento específico con métricas",
          "edge": "Edge analítico específico"
        },
        {
          "market": "Tercer mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "2.20",
          "confidence": 65,
          "reasoning": "Razonamiento específico",
          "edge": "Edge analítico específico"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks en 1 oración"
    }
  ]
}`;
}// /api/picks.js
import fs from "fs";
import path from "path";

// ---------- Caché en memoria ----------
let cachedMundial = null;
let cacheMundialTimestamp = 0;
const CACHE_MUNDIAL_TTL_MS = 24 * 60 * 60 * 1000;

let cachedUFC = null;
let cacheUFCTimestamp = 0;
const CACHE_UFC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_UFC_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY) return res.status(500).json({ error: "Falta GROQ_UFC_KEY." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY." });

  try {
    const now = Date.now();

    // ═══════════════════════════════════════
    // BLOQUE 1: MUNDIAL — ESPN + Groq
    // ═══════════════════════════════════════
    let mundialPicks = null;

    if (cachedMundial && (now - cacheMundialTimestamp) < CACHE_MUNDIAL_TTL_MS) {
      mundialPicks = cachedMundial;
    } else {
      // 1a. Obtener partidos de ESPN (hoy + mañana)
      const matches = await fetchESPNMatches();

      if (matches.length === 0) {
        mundialPicks = { picks: [], message: "No hay partidos del Mundial programados para hoy o mañana según ESPN." };
      } else {
        // 1b. Analizar con Groq
        const prompt = buildMundialPrompt(matches);
        const text = await callGroq(GROQ_KEY, prompt);
        const analysesArray = extractArray(text);

        if (analysesArray) {
          mundialPicks = { picks: analysesArray, updated: new Date().toISOString().split("T")[0] };
          cachedMundial = mundialPicks;
          cacheMundialTimestamp = now;
        } else {
          mundialPicks = { picks: [], message: "No se pudo analizar los partidos. Intenta de nuevo." };
        }
      }
    }

    // ═══════════════════════════════════════
    // BLOQUE 2: UFC — Gemini (sin grounding)
    // ═══════════════════════════════════════
    let ufcPicks = null;

    if (cachedUFC && (now - cacheUFCTimestamp) < CACHE_UFC_TTL_MS) {
      ufcPicks = cachedUFC;
    } else {
      const ufcPrompt = buildUFCPrompt();
      // FIX: sin responseMimeType ni grounding — los dos juntos rompen Gemini
      const ufcText = await callGemini(GEMINI_KEY, ufcPrompt);
      const ufcArray = extractArray(ufcText);

      if (ufcArray && ufcArray.length > 0) {
        ufcPicks = { fights: ufcArray };
        cachedUFC = ufcPicks;
        cacheUFCTimestamp = now;
      } else {
        ufcPicks = { fights: [], message: "No se pudo obtener el cartel de UFC de esta semana." };
      }
    }

    return res.status(200).json({ mundial: mundialPicks, ufc: ufcPicks });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── ESPN: partidos Mundial hoy + mañana ─────────────────────────────────────
async function fetchESPNMatches() {
  try {
    // Fechas en formato YYYYMMDD para ESPN
    const getDates = () => {
      const offset = -6; // UTC-6 México
      const d = new Date(new Date().getTime() + offset * 3600 * 1000);
      const fmt = (dateObj) => {
        const y = dateObj.getUTCFullYear();
        const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
        const day = String(dateObj.getUTCDate()).padStart(2, "0");
        return `${y}${m}${day}`;
      };
      const today = fmt(d);
      const tomorrow = fmt(new Date(d.getTime() + 24 * 3600 * 1000));
      return [today, tomorrow];
    };

    const [today, tomorrow] = getDates();
    const matches = [];

    for (const date of [today, tomorrow]) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`;
      const espnRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!espnRes.ok) continue;

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

        // Fecha y hora legible
        const dateStr = event.date ? new Date(event.date).toISOString().split("T")[0] : date;
        const timeUTC = event.date ? new Date(event.date).toUTCString().slice(17, 22) + " UTC" : "";

        // Venue
        const venue = competition.venue?.fullName || "";
        const city = competition.venue?.address?.city || "";
        const venueStr = [venue, city].filter(Boolean).join(", ");

        // Grupo/ronda
        const groupName = event.season?.slug || competition.series?.name || event.name || "";
        const notes = competition.notes?.[0]?.headline || "";

        // Forma reciente si ESPN la provee
        const homeRecord = home.records?.[0]?.summary || "";
        const awayRecord = away.records?.[0]?.summary || "";

        matches.push({
          match: `${homeName} vs ${awayName}`,
          home: homeName,
          away: awayName,
          date: dateStr,
          time: timeUTC,
          venue: venueStr,
          round: notes || groupName,
          home_record: homeRecord,
          away_record: awayRecord,
        });
      }
    }

    return matches;
  } catch (err) {
    console.error("Error ESPN:", err.message);
    // Fallback a fixtures.json si ESPN falla
    try {
      const fixturesPath = path.join(process.cwd(), "fixtures.json");
      const raw = fs.readFileSync(fixturesPath, "utf-8");
      const fixtureData = JSON.parse(raw);
      return fixtureData.matches || [];
    } catch {
      return [];
    }
  }
}

// ─── Groq (Mundial) ──────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Respuesta vacía de Groq");
  return text;
}

// ─── Gemini (UFC) — SIN responseMimeType ─────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          // SIN responseMimeType — era lo que rompía la respuesta de UFC
        },
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
    const err = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.warn("Gemini finishReason:", finishReason);
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Respuesta vacía de Gemini");
  return text;
}

// ─── Extraer array JSON ───────────────────────────────────────────────────────
function extractArray(text) {
  let clean = text.trim().replace(/^```json\n?/,"").replace(/\n?```$/,"");

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
    return null;
  } catch (e) {
    console.error("Error al parsear JSON:", e.message, "\nTexto:", text.substring(0, 300));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches) {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un scout profesional de fútbol y analista de apuestas deportivas de élite. Hoy es ${today}.

Analiza cada partido del Mundial 2026 que te proporciono y entrega EXACTAMENTE 3 picks por partido en mercados DISTINTOS. 

REGLAS CLAVE:
- NO uses solo "quién gana" como único pick. Explora mercados alternativos con fundamento real.
- Los mejores picks tienen valor analítico: no son los obvios, tienen respaldo táctico/estadístico específico.
- Prioriza picks con alta certeza analítica sobre picks arriesgados.
- Cada pick debe tener su propio razonamiento específico, no genérico.

MERCADOS DISPONIBLES (elige los 3 con más respaldo para cada partido):
- Handicap asiático (ej: "Equipo A -0.5", "Equipo B +1.5")
- Total de goles Over/Under (ej: "Menos de 2.5 goles")
- Resultado al descanso (ej: "Empate al HT")
- Primer tiempo Over/Under goles
- Ambos equipos anotan: Sí/No
- Corners Over/Under (si hay datos de estilo de juego)
- Tarjetas Over/Under (partidos físicos o de alta presión)
- Doble resultado (HT/FT)
- Ganador del partido (solo si hay ventaja táctica muy clara y cuota con valor)

Partidos a analizar:
${JSON.stringify(matches, null, 2)}

Devuelve SOLO este JSON sin texto adicional ni markdown:
{
  "analyses": [
    {
      "match": "Equipo A vs Equipo B",
      "meta": "Fecha · Sede · Ronda",
      "context": "1 oración sobre el contexto clave: qué se juega cada equipo, forma reciente, presión del partido",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta y clara",
          "odds_estimate": "1.75",
          "confidence": 74,
          "reasoning": "2-3 oraciones explicando qué patrón táctico, estadístico o situacional respalda específicamente este pick",
          "edge": "1 frase: la ventaja analítica que el mercado masivo suele ignorar"
        },
        {
          "market": "Segundo mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "1.90",
          "confidence": 68,
          "reasoning": "Razonamiento específico para este pick",
          "edge": "Edge analítico específico"
        },
        {
          "market": "Tercer mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "2.10",
          "confidence": 63,
          "reasoning": "Razonamiento específico para este pick",
          "edge": "Edge analítico específico"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks en 1 oración"
    }
  ]
}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de MMA y apuestas deportivas con conocimiento profundo de métricas avanzadas de peleadores (striking accuracy, takedown defense, significant strikes absorbed por minuto, etc.). Hoy es ${today}.

Busca el cartel de UFC más próximo de este fin de semana o los próximos 7 días. Para el main event y las 3-4 peleas más importantes, entrega EXACTAMENTE 3 picks por pelea en mercados DISTINTOS.

REGLAS CLAVE:
- NO uses solo "quién gana" como único pick. Los mejores picks en MMA están en mercados alternativos.
- Prioriza picks con alta certeza analítica: método de victoria específico, duración de pelea, etc.
- Cada pick debe tener razonamiento con métricas o tendencias reales del peleador.
- Prioriza seguridad analítica sobre cuotas altas.

MERCADOS DISPONIBLES (elige los 3 con más respaldo para cada pelea):
- Método de victoria: KO/TKO, Sumisión, Decisión unánime, Decisión dividida
- Over/Under de rounds (ej: "Menos de 1.5 rounds", "Más de 2.5 rounds")
- Llega al round X: Sí/No
- Pelea va a distancia (completa los rounds): Sí/No
- Ganador por decisión (cuando ambos tienen chin sólido y estilo defensivo)
- Parlay método + resultado (cuando hay alta certeza en ambos)
- Knockdown en la pelea: Sí/No (si hay diferencia clara en poder de golpeo)

Devuelve SOLO este JSON sin texto adicional ni markdown:
{
  "fights": [
    {
      "fight": "Peleador A vs Peleador B",
      "title": "Cinturón en juego o null",
      "weight_class": "División en español",
      "event": "Nombre del evento UFC",
      "date": "YYYY-MM-DD",
      "venue": "Sede, Ciudad",
      "context": "1 oración sobre el contexto: récords actuales, narrativa, forma reciente",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta y clara",
          "odds_estimate": "1.85",
          "confidence": 76,
          "reasoning": "2-3 oraciones con métricas o tendencias reales que respaldan este pick específicamente",
          "edge": "1 frase: la ventaja analítica que otros apostadores suelen perder de vista"
        },
        {
          "market": "Segundo mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "1.65",
          "confidence": 71,
          "reasoning": "Razonamiento específico con métricas",
          "edge": "Edge analítico específico"
        },
        {
          "market": "Tercer mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "2.20",
          "confidence": 65,
          "reasoning": "Razonamiento específico",
          "edge": "Edge analítico específico"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks en 1 oración"
    }
  ]
}`;
}// /api/picks.js
import fs from "fs";
import path from "path";

// ---------- Caché en memoria ----------
let cachedMundial = null;
let cacheMundialTimestamp = 0;
const CACHE_MUNDIAL_TTL_MS = 24 * 60 * 60 * 1000;

let cachedUFC = null;
let cacheUFCTimestamp = 0;
const CACHE_UFC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_UFC_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY) return res.status(500).json({ error: "Falta GROQ_UFC_KEY." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY." });

  try {
    const now = Date.now();

    // ═══════════════════════════════════════
    // BLOQUE 1: MUNDIAL — ESPN + Groq
    // ═══════════════════════════════════════
    let mundialPicks = null;

    if (cachedMundial && (now - cacheMundialTimestamp) < CACHE_MUNDIAL_TTL_MS) {
      mundialPicks = cachedMundial;
    } else {
      // 1a. Obtener partidos de ESPN (hoy + mañana)
      const matches = await fetchESPNMatches();

      if (matches.length === 0) {
        mundialPicks = { picks: [], message: "No hay partidos del Mundial programados para hoy o mañana según ESPN." };
      } else {
        // 1b. Analizar con Groq
        const prompt = buildMundialPrompt(matches);
        const text = await callGroq(GROQ_KEY, prompt);
        const analysesArray = extractArray(text);

        if (analysesArray) {
          mundialPicks = { picks: analysesArray, updated: new Date().toISOString().split("T")[0] };
          cachedMundial = mundialPicks;
          cacheMundialTimestamp = now;
        } else {
          mundialPicks = { picks: [], message: "No se pudo analizar los partidos. Intenta de nuevo." };
        }
      }
    }

    // ═══════════════════════════════════════
    // BLOQUE 2: UFC — Gemini (sin grounding)
    // ═══════════════════════════════════════
    let ufcPicks = null;

    if (cachedUFC && (now - cacheUFCTimestamp) < CACHE_UFC_TTL_MS) {
      ufcPicks = cachedUFC;
    } else {
      const ufcPrompt = buildUFCPrompt();
      // FIX: sin responseMimeType ni grounding — los dos juntos rompen Gemini
      const ufcText = await callGemini(GEMINI_KEY, ufcPrompt);
      const ufcArray = extractArray(ufcText);

      if (ufcArray && ufcArray.length > 0) {
        ufcPicks = { fights: ufcArray };
        cachedUFC = ufcPicks;
        cacheUFCTimestamp = now;
      } else {
        ufcPicks = { fights: [], message: "No se pudo obtener el cartel de UFC de esta semana." };
      }
    }

    return res.status(200).json({ mundial: mundialPicks, ufc: ufcPicks });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── ESPN: partidos Mundial hoy + mañana ─────────────────────────────────────
async function fetchESPNMatches() {
  try {
    // Fechas en formato YYYYMMDD para ESPN
    const getDates = () => {
      const offset = -6; // UTC-6 México
      const d = new Date(new Date().getTime() + offset * 3600 * 1000);
      const fmt = (dateObj) => {
        const y = dateObj.getUTCFullYear();
        const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
        const day = String(dateObj.getUTCDate()).padStart(2, "0");
        return `${y}${m}${day}`;
      };
      const today = fmt(d);
      const tomorrow = fmt(new Date(d.getTime() + 24 * 3600 * 1000));
      return [today, tomorrow];
    };

    const [today, tomorrow] = getDates();
    const matches = [];

    for (const date of [today, tomorrow]) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`;
      const espnRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!espnRes.ok) continue;

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

        // Fecha y hora legible
        const dateStr = event.date ? new Date(event.date).toISOString().split("T")[0] : date;
        const timeUTC = event.date ? new Date(event.date).toUTCString().slice(17, 22) + " UTC" : "";

        // Venue
        const venue = competition.venue?.fullName || "";
        const city = competition.venue?.address?.city || "";
        const venueStr = [venue, city].filter(Boolean).join(", ");

        // Grupo/ronda
        const groupName = event.season?.slug || competition.series?.name || event.name || "";
        const notes = competition.notes?.[0]?.headline || "";

        // Forma reciente si ESPN la provee
        const homeRecord = home.records?.[0]?.summary || "";
        const awayRecord = away.records?.[0]?.summary || "";

        matches.push({
          match: `${homeName} vs ${awayName}`,
          home: homeName,
          away: awayName,
          date: dateStr,
          time: timeUTC,
          venue: venueStr,
          round: notes || groupName,
          home_record: homeRecord,
          away_record: awayRecord,
        });
      }
    }

    return matches;
  } catch (err) {
    console.error("Error ESPN:", err.message);
    // Fallback a fixtures.json si ESPN falla
    try {
      const fixturesPath = path.join(process.cwd(), "fixtures.json");
      const raw = fs.readFileSync(fixturesPath, "utf-8");
      const fixtureData = JSON.parse(raw);
      return fixtureData.matches || [];
    } catch {
      return [];
    }
  }
}

// ─── Groq (Mundial) ──────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Respuesta vacía de Groq");
  return text;
}

// ─── Gemini (UFC) — SIN responseMimeType ─────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          // SIN responseMimeType — era lo que rompía la respuesta de UFC
        },
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
    const err = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.warn("Gemini finishReason:", finishReason);
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Respuesta vacía de Gemini");
  return text;
}

// ─── Extraer array JSON ───────────────────────────────────────────────────────
function extractArray(text) {
  let clean = text.trim().replace(/^```json\n?/,"").replace(/\n?```$/,"");

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
    return null;
  } catch (e) {
    console.error("Error al parsear JSON:", e.message, "\nTexto:", text.substring(0, 300));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches) {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un scout profesional de fútbol y analista de apuestas deportivas de élite. Hoy es ${today}.

Analiza cada partido del Mundial 2026 que te proporciono y entrega EXACTAMENTE 3 picks por partido en mercados DISTINTOS. 

REGLAS CLAVE:
- NO uses solo "quién gana" como único pick. Explora mercados alternativos con fundamento real.
- Los mejores picks tienen valor analítico: no son los obvios, tienen respaldo táctico/estadístico específico.
- Prioriza picks con alta certeza analítica sobre picks arriesgados.
- Cada pick debe tener su propio razonamiento específico, no genérico.

MERCADOS DISPONIBLES (elige los 3 con más respaldo para cada partido):
- Handicap asiático (ej: "Equipo A -0.5", "Equipo B +1.5")
- Total de goles Over/Under (ej: "Menos de 2.5 goles")
- Resultado al descanso (ej: "Empate al HT")
- Primer tiempo Over/Under goles
- Ambos equipos anotan: Sí/No
- Corners Over/Under (si hay datos de estilo de juego)
- Tarjetas Over/Under (partidos físicos o de alta presión)
- Doble resultado (HT/FT)
- Ganador del partido (solo si hay ventaja táctica muy clara y cuota con valor)

Partidos a analizar:
${JSON.stringify(matches, null, 2)}

Devuelve SOLO este JSON sin texto adicional ni markdown:
{
  "analyses": [
    {
      "match": "Equipo A vs Equipo B",
      "meta": "Fecha · Sede · Ronda",
      "context": "1 oración sobre el contexto clave: qué se juega cada equipo, forma reciente, presión del partido",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta y clara",
          "odds_estimate": "1.75",
          "confidence": 74,
          "reasoning": "2-3 oraciones explicando qué patrón táctico, estadístico o situacional respalda específicamente este pick",
          "edge": "1 frase: la ventaja analítica que el mercado masivo suele ignorar"
        },
        {
          "market": "Segundo mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "1.90",
          "confidence": 68,
          "reasoning": "Razonamiento específico para este pick",
          "edge": "Edge analítico específico"
        },
        {
          "market": "Tercer mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "2.10",
          "confidence": 63,
          "reasoning": "Razonamiento específico para este pick",
          "edge": "Edge analítico específico"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks en 1 oración"
    }
  ]
}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de MMA y apuestas deportivas con conocimiento profundo de métricas avanzadas de peleadores (striking accuracy, takedown defense, significant strikes absorbed por minuto, etc.). Hoy es ${today}.

Busca el cartel de UFC más próximo de este fin de semana o los próximos 7 días. Para el main event y las 3-4 peleas más importantes, entrega EXACTAMENTE 3 picks por pelea en mercados DISTINTOS.

REGLAS CLAVE:
- NO uses solo "quién gana" como único pick. Los mejores picks en MMA están en mercados alternativos.
- Prioriza picks con alta certeza analítica: método de victoria específico, duración de pelea, etc.
- Cada pick debe tener razonamiento con métricas o tendencias reales del peleador.
- Prioriza seguridad analítica sobre cuotas altas.

MERCADOS DISPONIBLES (elige los 3 con más respaldo para cada pelea):
- Método de victoria: KO/TKO, Sumisión, Decisión unánime, Decisión dividida
- Over/Under de rounds (ej: "Menos de 1.5 rounds", "Más de 2.5 rounds")
- Llega al round X: Sí/No
- Pelea va a distancia (completa los rounds): Sí/No
- Ganador por decisión (cuando ambos tienen chin sólido y estilo defensivo)
- Parlay método + resultado (cuando hay alta certeza en ambos)
- Knockdown en la pelea: Sí/No (si hay diferencia clara en poder de golpeo)

Devuelve SOLO este JSON sin texto adicional ni markdown:
{
  "fights": [
    {
      "fight": "Peleador A vs Peleador B",
      "title": "Cinturón en juego o null",
      "weight_class": "División en español",
      "event": "Nombre del evento UFC",
      "date": "YYYY-MM-DD",
      "venue": "Sede, Ciudad",
      "context": "1 oración sobre el contexto: récords actuales, narrativa, forma reciente",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta y clara",
          "odds_estimate": "1.85",
          "confidence": 76,
          "reasoning": "2-3 oraciones con métricas o tendencias reales que respaldan este pick específicamente",
          "edge": "1 frase: la ventaja analítica que otros apostadores suelen perder de vista"
        },
        {
          "market": "Segundo mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "1.65",
          "confidence": 71,
          "reasoning": "Razonamiento específico con métricas",
          "edge": "Edge analítico específico"
        },
        {
          "market": "Tercer mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "2.20",
          "confidence": 65,
          "reasoning": "Razonamiento específico",
          "edge": "Edge analítico específico"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks en 1 oración"
    }
  ]
}`;
}// /api/picks.js
import fs from "fs";
import path from "path";

// ---------- Caché en memoria ----------
let cachedMundial = null;
let cacheMundialTimestamp = 0;
const CACHE_MUNDIAL_TTL_MS = 24 * 60 * 60 * 1000;

let cachedUFC = null;
let cacheUFCTimestamp = 0;
const CACHE_UFC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_UFC_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY) return res.status(500).json({ error: "Falta GROQ_UFC_KEY." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY." });

  try {
    const now = Date.now();

    // ═══════════════════════════════════════
    // BLOQUE 1: MUNDIAL — ESPN + Groq
    // ═══════════════════════════════════════
    let mundialPicks = null;

    if (cachedMundial && (now - cacheMundialTimestamp) < CACHE_MUNDIAL_TTL_MS) {
      mundialPicks = cachedMundial;
    } else {
      // 1a. Obtener partidos de ESPN (hoy + mañana)
      const matches = await fetchESPNMatches();

      if (matches.length === 0) {
        mundialPicks = { picks: [], message: "No hay partidos del Mundial programados para hoy o mañana según ESPN." };
      } else {
        // 1b. Analizar con Groq
        const prompt = buildMundialPrompt(matches);
        const text = await callGroq(GROQ_KEY, prompt);
        const analysesArray = extractArray(text);

        if (analysesArray) {
          mundialPicks = { picks: analysesArray, updated: new Date().toISOString().split("T")[0] };
          cachedMundial = mundialPicks;
          cacheMundialTimestamp = now;
        } else {
          mundialPicks = { picks: [], message: "No se pudo analizar los partidos. Intenta de nuevo." };
        }
      }
    }

    // ═══════════════════════════════════════
    // BLOQUE 2: UFC — Gemini (sin grounding)
    // ═══════════════════════════════════════
    let ufcPicks = null;

    if (cachedUFC && (now - cacheUFCTimestamp) < CACHE_UFC_TTL_MS) {
      ufcPicks = cachedUFC;
    } else {
      const ufcPrompt = buildUFCPrompt();
      // FIX: sin responseMimeType ni grounding — los dos juntos rompen Gemini
      const ufcText = await callGemini(GEMINI_KEY, ufcPrompt);
      const ufcArray = extractArray(ufcText);

      if (ufcArray && ufcArray.length > 0) {
        ufcPicks = { fights: ufcArray };
        cachedUFC = ufcPicks;
        cacheUFCTimestamp = now;
      } else {
        ufcPicks = { fights: [], message: "No se pudo obtener el cartel de UFC de esta semana." };
      }
    }

    return res.status(200).json({ mundial: mundialPicks, ufc: ufcPicks });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── ESPN: partidos Mundial hoy + mañana ─────────────────────────────────────
async function fetchESPNMatches() {
  try {
    // Fechas en formato YYYYMMDD para ESPN
    const getDates = () => {
      const offset = -6; // UTC-6 México
      const d = new Date(new Date().getTime() + offset * 3600 * 1000);
      const fmt = (dateObj) => {
        const y = dateObj.getUTCFullYear();
        const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
        const day = String(dateObj.getUTCDate()).padStart(2, "0");
        return `${y}${m}${day}`;
      };
      const today = fmt(d);
      const tomorrow = fmt(new Date(d.getTime() + 24 * 3600 * 1000));
      return [today, tomorrow];
    };

    const [today, tomorrow] = getDates();
    const matches = [];

    for (const date of [today, tomorrow]) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`;
      const espnRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!espnRes.ok) continue;

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

        // Fecha y hora legible
        const dateStr = event.date ? new Date(event.date).toISOString().split("T")[0] : date;
        const timeUTC = event.date ? new Date(event.date).toUTCString().slice(17, 22) + " UTC" : "";

        // Venue
        const venue = competition.venue?.fullName || "";
        const city = competition.venue?.address?.city || "";
        const venueStr = [venue, city].filter(Boolean).join(", ");

        // Grupo/ronda
        const groupName = event.season?.slug || competition.series?.name || event.name || "";
        const notes = competition.notes?.[0]?.headline || "";

        // Forma reciente si ESPN la provee
        const homeRecord = home.records?.[0]?.summary || "";
        const awayRecord = away.records?.[0]?.summary || "";

        matches.push({
          match: `${homeName} vs ${awayName}`,
          home: homeName,
          away: awayName,
          date: dateStr,
          time: timeUTC,
          venue: venueStr,
          round: notes || groupName,
          home_record: homeRecord,
          away_record: awayRecord,
        });
      }
    }

    return matches;
  } catch (err) {
    console.error("Error ESPN:", err.message);
    // Fallback a fixtures.json si ESPN falla
    try {
      const fixturesPath = path.join(process.cwd(), "fixtures.json");
      const raw = fs.readFileSync(fixturesPath, "utf-8");
      const fixtureData = JSON.parse(raw);
      return fixtureData.matches || [];
    } catch {
      return [];
    }
  }
}

// ─── Groq (Mundial) ──────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Respuesta vacía de Groq");
  return text;
}

// ─── Gemini (UFC) — SIN responseMimeType ─────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          // SIN responseMimeType — era lo que rompía la respuesta de UFC
        },
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
    const err = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.warn("Gemini finishReason:", finishReason);
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Respuesta vacía de Gemini");
  return text;
}

// ─── Extraer array JSON ───────────────────────────────────────────────────────
function extractArray(text) {
  let clean = text.trim().replace(/^```json\n?/,"").replace(/\n?```$/,"");

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
    return null;
  } catch (e) {
    console.error("Error al parsear JSON:", e.message, "\nTexto:", text.substring(0, 300));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches) {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un scout profesional de fútbol y analista de apuestas deportivas de élite. Hoy es ${today}.

Analiza cada partido del Mundial 2026 que te proporciono y entrega EXACTAMENTE 3 picks por partido en mercados DISTINTOS. 

REGLAS CLAVE:
- NO uses solo "quién gana" como único pick. Explora mercados alternativos con fundamento real.
- Los mejores picks tienen valor analítico: no son los obvios, tienen respaldo táctico/estadístico específico.
- Prioriza picks con alta certeza analítica sobre picks arriesgados.
- Cada pick debe tener su propio razonamiento específico, no genérico.

MERCADOS DISPONIBLES (elige los 3 con más respaldo para cada partido):
- Handicap asiático (ej: "Equipo A -0.5", "Equipo B +1.5")
- Total de goles Over/Under (ej: "Menos de 2.5 goles")
- Resultado al descanso (ej: "Empate al HT")
- Primer tiempo Over/Under goles
- Ambos equipos anotan: Sí/No
- Corners Over/Under (si hay datos de estilo de juego)
- Tarjetas Over/Under (partidos físicos o de alta presión)
- Doble resultado (HT/FT)
- Ganador del partido (solo si hay ventaja táctica muy clara y cuota con valor)

Partidos a analizar:
${JSON.stringify(matches, null, 2)}

Devuelve SOLO este JSON sin texto adicional ni markdown:
{
  "analyses": [
    {
      "match": "Equipo A vs Equipo B",
      "meta": "Fecha · Sede · Ronda",
      "context": "1 oración sobre el contexto clave: qué se juega cada equipo, forma reciente, presión del partido",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta y clara",
          "odds_estimate": "1.75",
          "confidence": 74,
          "reasoning": "2-3 oraciones explicando qué patrón táctico, estadístico o situacional respalda específicamente este pick",
          "edge": "1 frase: la ventaja analítica que el mercado masivo suele ignorar"
        },
        {
          "market": "Segundo mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "1.90",
          "confidence": 68,
          "reasoning": "Razonamiento específico para este pick",
          "edge": "Edge analítico específico"
        },
        {
          "market": "Tercer mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "2.10",
          "confidence": 63,
          "reasoning": "Razonamiento específico para este pick",
          "edge": "Edge analítico específico"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks en 1 oración"
    }
  ]
}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de MMA y apuestas deportivas con conocimiento profundo de métricas avanzadas de peleadores (striking accuracy, takedown defense, significant strikes absorbed por minuto, etc.). Hoy es ${today}.

Busca el cartel de UFC más próximo de este fin de semana o los próximos 7 días. Para el main event y las 3-4 peleas más importantes, entrega EXACTAMENTE 3 picks por pelea en mercados DISTINTOS.

REGLAS CLAVE:
- NO uses solo "quién gana" como único pick. Los mejores picks en MMA están en mercados alternativos.
- Prioriza picks con alta certeza analítica: método de victoria específico, duración de pelea, etc.
- Cada pick debe tener razonamiento con métricas o tendencias reales del peleador.
- Prioriza seguridad analítica sobre cuotas altas.

MERCADOS DISPONIBLES (elige los 3 con más respaldo para cada pelea):
- Método de victoria: KO/TKO, Sumisión, Decisión unánime, Decisión dividida
- Over/Under de rounds (ej: "Menos de 1.5 rounds", "Más de 2.5 rounds")
- Llega al round X: Sí/No
- Pelea va a distancia (completa los rounds): Sí/No
- Ganador por decisión (cuando ambos tienen chin sólido y estilo defensivo)
- Parlay método + resultado (cuando hay alta certeza en ambos)
- Knockdown en la pelea: Sí/No (si hay diferencia clara en poder de golpeo)

Devuelve SOLO este JSON sin texto adicional ni markdown:
{
  "fights": [
    {
      "fight": "Peleador A vs Peleador B",
      "title": "Cinturón en juego o null",
      "weight_class": "División en español",
      "event": "Nombre del evento UFC",
      "date": "YYYY-MM-DD",
      "venue": "Sede, Ciudad",
      "context": "1 oración sobre el contexto: récords actuales, narrativa, forma reciente",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta y clara",
          "odds_estimate": "1.85",
          "confidence": 76,
          "reasoning": "2-3 oraciones con métricas o tendencias reales que respaldan este pick específicamente",
          "edge": "1 frase: la ventaja analítica que otros apostadores suelen perder de vista"
        },
        {
          "market": "Segundo mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "1.65",
          "confidence": 71,
          "reasoning": "Razonamiento específico con métricas",
          "edge": "Edge analítico específico"
        },
        {
          "market": "Tercer mercado distinto",
          "selection": "Apuesta exacta",
          "odds_estimate": "2.20",
          "confidence": 65,
          "reasoning": "Razonamiento específico",
          "edge": "Edge analítico específico"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks en 1 oración"
    }
  ]
}`;
}
