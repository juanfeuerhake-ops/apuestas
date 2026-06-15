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

  if (!GROQ_KEY) return res.status(500).json({ error: "Falta GROQ_UFC_KEY en las variables de entorno." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY en las variables de entorno." });

  try {
    const now = Date.now();

    // ═══════════════════════════════════════
    // BLOQUE 1: PICKS MUNDIAL via Groq
    // ═══════════════════════════════════════
    let mundialPicks = null;

    if (cachedMundial && (now - cacheMundialTimestamp) < CACHE_MUNDIAL_TTL_MS) {
      mundialPicks = cachedMundial;
    } else {
      const fixturesPath = path.join(process.cwd(), "fixtures.json");
      const raw = fs.readFileSync(fixturesPath, "utf-8");
      const fixtureData = JSON.parse(raw);
      const allMatches = fixtureData.matches || [];

      const getTodayAndTomorrow = () => {
        const offset = -6;
        const d = new Date(new Date().getTime() + offset * 3600 * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        const fmt = (dateObj) => `${dateObj.getUTCFullYear()}-${pad(dateObj.getUTCMonth() + 1)}-${pad(dateObj.getUTCDate())}`;
        const todayStr = fmt(d);
        const tomorrowStr = fmt(new Date(d.getTime() + 24 * 3600 * 1000));
        return [todayStr, tomorrowStr];
      };

      const [today, tomorrow] = getTodayAndTomorrow();
      const matches = allMatches.filter(m => m.date === today || m.date === tomorrow);

      if (matches.length > 0) {
        const prompt = buildMundialPrompt(matches, fixtureData.updated);
        const text = await callGroq(GROQ_KEY, prompt);
        const analysesArray = extractArray(text);

        if (analysesArray) {
          mundialPicks = { picks: analysesArray, updated: fixtureData.updated };
          cachedMundial = mundialPicks;
          cacheMundialTimestamp = now;
        } else {
          mundialPicks = { picks: [], message: "No se pudo analizar los partidos. Intenta de nuevo." };
        }
      } else {
        mundialPicks = {
          picks: [],
          message: `No hay partidos del Mundial para hoy (${today}) o mañana (${tomorrow}).`
        };
      }
    }

    // ═══════════════════════════════════════
    // BLOQUE 2: PICKS UFC via Gemini
    // ═══════════════════════════════════════
    let ufcPicks = null;

    if (cachedUFC && (now - cacheUFCTimestamp) < CACHE_UFC_TTL_MS) {
      ufcPicks = cachedUFC;
    } else {
      const ufcPrompt = buildUFCPrompt();
      const ufcText = await callGemini(GEMINI_KEY, ufcPrompt);
      const ufcArray = extractArray(ufcText);

      if (ufcArray) {
        ufcPicks = { fights: ufcArray };
        cachedUFC = ufcPicks;
        cacheUFCTimestamp = now;
      } else {
        ufcPicks = { fights: [], message: "No se pudo obtener el cartel de UFC de esta semana." };
      }
    }

    return res.status(200).json({ mundial: mundialPicks, ufc: ufcPicks });

  } catch (err) {
    return res.status(500).json({ error: err.message });
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
      model: "llama-3.3-70b-versatile",
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

// ─── Gemini (UFC) ────────────────────────────────────────────────────────────
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
          responseMimeType: "application/json",
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
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Respuesta vacía de Gemini");
  return text;
}

// ─── Extraer array JSON ───────────────────────────────────────────────────────
function extractArray(text) {
  let clean = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");

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
    console.error("Error al parsear JSON:", e.message, text.substring(0, 200));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches, updated) {
  return `Eres un scout profesional de fútbol y analista de apuestas con acceso a datos tácticos, estadísticos e históricos. Tu objetivo es identificar picks de VALOR REAL: no los obvios, sino los que tienen respaldo analítico sólido y que las casas de apuestas suelen subestimar.

Analiza cada partido del Mundial 2026 (datos al ${updated}) y para cada uno entrega 2-3 picks en mercados distintos. NO uses solo "ganador del partido". Explora mercados alternativos con fundamento real.

MERCADOS DISPONIBLES (elige los que tengan más respaldo analítico para ese partido):
- Resultado al descanso (ej: "Empate al HT aunque gane uno al final")
- Handicap asiático (ej: "-0.5 al equipo X", "+1.5 al equipo Y")
- Total de goles over/under (ej: "Menos de 2.5 goles" con fundamento defensivo)
- Ambos equipos anotan: Sí/No
- Primer tiempo over/under (ej: "Menos de 1.5 goles en el 1T")
- Goles en la segunda mitad (si un equipo suele arrancar lento)
- Tarjetas: over/under (si el partido tiene historial físico)
- Corners: over/under (si un equipo domina en posesión y centros)

Para cada pick explica el RAZONAMIENTO ESPECÍFICO: por qué ese mercado, qué patrón táctico o estadístico lo respalda, y por qué tiene valor real (no es solo apostar al favorito obvio).

Partidos a analizar:
${JSON.stringify(matches)}

Devuelve SOLO este JSON sin texto adicional:
{
  "analyses": [
    {
      "match": "Equipo A vs Equipo B",
      "meta": "Fecha, sede, grupo",
      "context": "1 oración sobre el contexto clave del partido (stakes, forma, presión)",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta",
          "odds_estimate": "cuota estimada como string ej: 1.75",
          "confidence": 72,
          "reasoning": "Explicación de 2-3 oraciones: qué patrón táctico/estadístico respalda esto y por qué tiene valor real más allá del favorito obvio",
          "edge": "En 1 frase: la ventaja analítica que otros apostadores suelen perder de vista"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks"
    }
  ]
}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de MMA y apuestas deportivas con conocimiento profundo de estilos de pelea, récords, tendencias físicas y métricas avanzadas (striking accuracy, takedown defense, significant strikes absorbed, etc.). Hoy es ${today}.

Tu tarea: identificar el cartel de UFC de este fin de semana o los próximos 7 días y para cada pelea importante entregar 2-3 picks en mercados distintos con fundamento analítico real. NO solo "quién gana". Los mejores picks en MMA están en los mercados alternativos.

MERCADOS DISPONIBLES (elige los que tengan respaldo real):
- Método de victoria: KO/TKO, Sumisión, Decisión (unánime o dividida)
- Over/Under de rounds (ej: "Menos de 1.5 rounds" si hay KO power o "Más de 2.5" si hay chin sólido)
- Llega al round X: Sí/No (ej: "Llega al round 3: No" si un peleador cierra rápido)
- Pelea va a distancia: Sí/No
- Decisión unánime vs dividida
- Parlay de método + resultado cuando hay alta certeza

Para cada pick explica el RAZONAMIENTO ESPECÍFICO: qué métricas, tendencias de estilo o situación (peso, campamento, historial de lesiones, racha) lo respaldan. Prioriza picks seguros con valor analítico, no apuestas arriesgadas.

Peleas a cubrir: el main event + 3-4 peleas más importantes del cartel.

Devuelve SOLO este JSON sin texto adicional:
{
  "fights": [
    {
      "fight": "Peleador A vs Peleador B",
      "title": "Cinturón en juego o null",
      "weight_class": "División en español",
      "event": "Nombre del evento",
      "date": "YYYY-MM-DD",
      "venue": "Sede, Ciudad",
      "context": "1 oración sobre el contexto clave (stakes, narrativa, forma reciente)",
      "picks": [
        {
          "market": "Nombre del mercado",
          "selection": "Apuesta exacta",
          "odds_estimate": "cuota estimada como string ej: 1.85",
          "confidence": 75,
          "reasoning": "Explicación de 2-3 oraciones: qué métricas o patrones de estilo respaldan esto específicamente",
          "edge": "En 1 frase: la ventaja analítica que otros apostadores suelen perder de vista"
        }
      ],
      "risk": "Principal factor que podría invalidar estos picks"
    }
  ]
}`;
}
