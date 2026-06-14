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
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_UFC_KEY = process.env.GEMINI_UFC_KEY || GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Falta la variable de entorno GEMINI_API_KEY." });
  }

  // ---------- Ruta de prueba ----------
  if (req.query.test === "true") {
    try {
      const geminiRes = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Escribe un cuento corto de 150 palabras sobre un gato aventurero en el espacio." }] }],
          }),
        }
      );
      if (!geminiRes.ok) return res.status(502).json({ error: `Test falló HTTP ${geminiRes.status}` });
      const data = await geminiRes.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return res.status(200).json({ success: true, length: text.length, text });
    } catch (err) {
      return res.status(500).json({ error: "Test error", details: err.message });
    }
  }

  try {
    const now = Date.now();

    // ═══════════════════════════════════════
    // BLOQUE 1: PICKS MUNDIAL (caché 24h)
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
        const geminiData = await callGemini(GEMINI_API_KEY, prompt);
        const analysesArray = extractArray(geminiData);

        if (analysesArray) {
          const picksArray = analysesArray.map(p => mapMundialPick(p));
          mundialPicks = { picks: picksArray, updated: fixtureData.updated };
          cachedMundial = mundialPicks;
          cacheMundialTimestamp = now;
        }
      } else {
        mundialPicks = {
          picks: [],
          message: `No hay partidos del Mundial para hoy (${today}) o mañana (${tomorrow}).`
        };
      }
    }

    // ═══════════════════════════════════════
    // BLOQUE 2: PICKS UFC (caché 7 días)
    // ═══════════════════════════════════════
    let ufcPicks = null;

    if (cachedUFC && (now - cacheUFCTimestamp) < CACHE_UFC_TTL_MS) {
      ufcPicks = cachedUFC;
    } else {
      const ufcPrompt = buildUFCPrompt();
      const ufcGeminiData = await callGemini(GEMINI_UFC_KEY, ufcPrompt, true);
      const ufcArray = extractArray(ufcGeminiData);

      if (ufcArray) {
        ufcPicks = { fights: ufcArray };
        cachedUFC = ufcPicks;
        cacheUFCTimestamp = now;
      } else {
        ufcPicks = { fights: [], message: "No se pudo obtener el cartel de UFC de esta semana." };
      }
    }

    return res.status(200).json({
      mundial: mundialPicks,
      ufc: ufcPicks,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Llamada genérica a Gemini ───────────────────────────────────────────────
async function callGemini(apiKey, prompt, useWebSearch = false) {
  const body = {
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
  };

  // Para UFC habilitamos grounding con Google Search para que Gemini busque el cartel real
  if (useWebSearch) {
    body.tools = [{ google_search: {} }];
    // Con grounding no se puede usar responseMimeType, así que lo quitamos
    delete body.generationConfig.responseMimeType;
  }

  const geminiRes = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    }
  );

  if (!geminiRes.ok) {
    const errBody = await geminiRes.text();
    throw new Error(`Gemini HTTP ${geminiRes.status}: ${errBody}`);
  }

  const data = await geminiRes.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.warn("Gemini finishReason:", finishReason);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Respuesta vacía de Gemini");

  return text;
}

// ─── Extraer array JSON de la respuesta de Gemini ────────────────────────────
function extractArray(text) {
  let clean = text.trim();
  // Quitar markdown si lo hay
  clean = clean.replace(/^```json\n?/, "").replace(/\n?```$/, "");

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
    console.error("Error al parsear JSON de Gemini:", e.message);
    console.error("Texto:", text.substring(0, 300));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches, updated) {
  return `Eres un analista y redactor periodístico de fútbol. Escribe un análisis táctico deportivo para los siguientes partidos del Mundial 2026 (datos actualizados al ${updated}).

Por cada partido, proporciona un análisis estructurado únicamente en base al estado de forma física y táctica provisto para cada selección (home_form / away_form / notes).

Devuelve los siguientes campos exactos por partido (sé conciso, máx 15 palabras por campo de texto):
- match: nombre del partido.
- meta: metadata proporcionada (Fecha, sede, etc.).
- tactical_style: estilo táctico previsto (máx 8 palabras).
- tactical_favor: EXACTAMENTE una de estas tres opciones: "Local favorito", "Visitante favorito" o "Muy equilibrado".
- reasons: array con EXACTAMENTE 2 strings, máx 15 palabras cada uno.
- tactical_risk: principal riesgo táctico (máx 12 palabras).

Partidos a analizar:
${JSON.stringify(matches)}

Responde ÚNICAMENTE con el JSON, sin Markdown ni texto adicional:
{"analyses":[{"match":"A vs B","meta":"...","tactical_style":"...","tactical_favor":"Local favorito","reasons":["...","..."],"tactical_risk":"..."}]}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista de MMA y artes marciales mixtas. Hoy es ${today}.

Busca el cartel de UFC más próximo que ocurre este fin de semana o en los próximos 7 días. Incluye el evento principal (main event) y al menos las 3-5 peleas más importantes (co-main y peleas estelares).

Para cada pelea, devuelve un análisis con estos campos exactos (máx 15 palabras por campo de texto):
- fight: "Peleador A vs Peleador B" (nombres reales)
- title: si es pelea de título, escribe el cinturón en juego, si no escribe null
- weight_class: división de peso en español (ej: "Peso Pesado", "Peso Ligero")
- event: nombre del evento UFC (ej: "UFC 317", "UFC Fight Night")
- date: fecha en formato YYYY-MM-DD
- venue: sede y ciudad
- favor: EXACTAMENTE una de: "Favorito A", "Favorito B" o "Muy equilibrado" (reemplaza A y B con el nombre del peleador favorito)
- style: estilo de pelea previsto (máx 8 palabras, ej: "Lucha dominante y ground and pound")
- reasons: array con EXACTAMENTE 2 strings, máx 15 palabras cada uno
- risk: principal riesgo o wildcard de la pelea (máx 12 palabras)

Responde ÚNICAMENTE con el JSON, sin Markdown ni texto adicional:
{"fights":[{"fight":"...","title":null,"weight_class":"...","event":"...","date":"...","venue":"...","favor":"...","style":"...","reasons":["...","..."],"risk":"..."}]}`;
}

// ─── Mapear pick del Mundial al formato del frontend ─────────────────────────
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
    risk: p.tactical_risk || p.challenge || p.risk || "",
  };
}
