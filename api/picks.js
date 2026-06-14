// /api/picks.js
import fs from "fs";
import path from "path";

// ---------- Caché en memoria ----------
let cachedMundial = null;
let cacheMundialTimestamp = 0;
const CACHE_MUNDIAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

let cachedUFC = null;
let cacheUFCTimestamp = 0;
const CACHE_UFC_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_UFC_KEY;       // Groq → Mundial
  const GEMINI_KEY = process.env.GEMINI_API_KEY;   // Gemini → UFC

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
          const picksArray = analysesArray.map(p => mapMundialPick(p));
          mundialPicks = { picks: picksArray, updated: fixtureData.updated };
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
      temperature: 0.4,
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
          temperature: 0.4,
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
  return `Eres un analista de fútbol. Analiza los siguientes partidos del Mundial 2026 (datos al ${updated}).

Por cada partido devuelve estos campos (máx 15 palabras por campo de texto):
- match: nombre del partido
- meta: metadata (Fecha, sede, etc.)
- tactical_style: estilo táctico previsto (máx 8 palabras)
- tactical_favor: EXACTAMENTE una de: "Local favorito", "Visitante favorito" o "Muy equilibrado"
- reasons: array con EXACTAMENTE 2 strings, máx 15 palabras cada uno
- tactical_risk: principal riesgo táctico (máx 12 palabras)

Partidos:
${JSON.stringify(matches)}

Responde SOLO con JSON válido, sin texto adicional:
{"analyses":[{"match":"A vs B","meta":"...","tactical_style":"...","tactical_favor":"Local favorito","reasons":["...","..."],"tactical_risk":"..."}]}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista de MMA. Hoy es ${today}.

Lista el cartel de UFC más próximo este fin de semana o próximos 7 días. Incluye el main event y las 3-5 peleas más importantes.

Por cada pelea devuelve (máx 15 palabras por campo):
- fight: "Peleador A vs Peleador B"
- title: cinturón en juego o null
- weight_class: división en español
- event: nombre del evento (ej: "UFC 317")
- date: formato YYYY-MM-DD
- venue: sede y ciudad
- favor: EXACTAMENTE una de: "Favorito [nombre]" o "Muy equilibrado"
- style: estilo de pelea previsto (máx 8 palabras)
- reasons: array con EXACTAMENTE 2 strings, máx 15 palabras cada uno
- risk: principal wildcard (máx 12 palabras)

Responde SOLO con JSON válido, sin texto adicional:
{"fights":[{"fight":"...","title":null,"weight_class":"...","event":"...","date":"...","venue":"...","favor":"...","style":"...","reasons":["...","..."],"risk":"..."}]}`;
}

// ─── Mapear pick Mundial ──────────────────────────────────────────────────────
function mapMundialPick(p) {
  const teams = (p.match || "").split(" vs ");
  const homeTeam = teams[0]?.trim() || "Local";
  const awayTeam = teams[1]?.trim() || "Visitante";

  let confidence = 50;
  const selections = [];

  const favor = p.tactical_favor || "";
  if (favor.toLowerCase().includes("local")) {
    confidence = 78;
    selections.push({ market: "Resultado final", selection: `Ganador ${homeTeam}`, odds_estimate: "1.52" });
  } else if (favor.toLowerCase().includes("visitante")) {
    confidence = 76;
    selections.push({ market: "Resultado final", selection: `Ganador ${awayTeam}`, odds_estimate: "1.68" });
  } else {
    confidence = 58;
    selections.push({ market: "Doble oportunidad", selection: `${homeTeam} o Empate`, odds_estimate: "1.35" });
  }

  const style = (p.tactical_style || "").toLowerCase();
  if (style.includes("ataque") || style.includes("ofensivo") || style.includes("goles") || style.includes("presión alta")) {
    selections.push({ market: "Total de goles", selection: "Más de 1.5 goles", odds_estimate: "1.25" });
  } else if (style.includes("defensa") || style.includes("defensivo") || style.includes("bloque bajo") || style.includes("pocos goles")) {
    selections.push({ market: "Total de goles", selection: "Menos de 3.5 goles", odds_estimate: "1.30" });
  } else {
    selections.push({ market: "Ambos anotan", selection: "Sí anotan", odds_estimate: "1.75" });
  }

  return {
    match: p.match,
    meta: p.meta,
    confidence,
    selections,
    reasons: p.reasons || [],
    risk: p.tactical_risk || p.risk || "",
  };
}
