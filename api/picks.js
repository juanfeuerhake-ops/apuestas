// /api/picks.js
import fs from "fs";
import path from "path";

let cachedMundial = null;
let cacheMundialTimestamp = 0;
const CACHE_MUNDIAL_TTL_MS = 24 * 60 * 60 * 1000;

let cachedUFC = null;
let cachedUFCWeek = null;

function getISOWeek(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return monday.toISOString().split("T")[0];
}

export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_UFC_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY) return res.status(500).json({ error: "Falta GROQ_UFC_KEY en variables de entorno." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY en variables de entorno." });

  const now = Date.now();
  let mundialPicks = null;
  let ufcPicks = null;

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
        const text = await callGroq(GROQ_KEY, buildMundialPrompt(matches));
        const arr = extractArray(text);
        if (arr && arr.length > 0) {
          mundialPicks = { picks: arr, updated: new Date().toISOString().split("T")[0] };
          cachedMundial = mundialPicks;
          cacheMundialTimestamp = now;
        } else {
          mundialPicks = { picks: [], message: "La IA no pudo generar análisis. Intenta de nuevo." };
        }
      }
    }
  } catch (err) {
    console.error("Error MUNDIAL:", err);
    mundialPicks = { picks: [], message: `Error Mundial: ${String(err?.message || err)}` };
  }

  // ═══════════════════════════════════════
  // BLOQUE 2: UFC — Gemini
  // ═══════════════════════════════════════
  try {
    const thisWeek = getISOWeek(now);
    if (cachedUFC && cachedUFCWeek === thisWeek) {
      ufcPicks = cachedUFC;
    } else {
      const text = await callGemini(GEMINI_KEY, buildUFCPrompt());
      const arr = extractArray(text);
      if (arr && arr.length > 0) {
        ufcPicks = { fights: arr };
        cachedUFC = ufcPicks;
        cachedUFCWeek = thisWeek;
      } else {
        ufcPicks = { fights: [], message: "No se pudo obtener el cartel de UFC esta semana." };
      }
    }
  } catch (err) {
    console.error("Error UFC:", err);
    ufcPicks = { fights: [], message: `Error UFC: ${String(err?.message || err)}` };
  }

  return res.status(200).json({ mundial: mundialPicks, ufc: ufcPicks });
}

// ─── ESPN ─────────────────────────────────────────────────────────────────────
async function fetchESPNMatches() {
  const offset = -6;
  const now = new Date(new Date().getTime() + offset * 3600 * 1000);
  const pad = n => String(n).padStart(2, "0");
  const fmtESPN = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}`;
  const fmtISO  = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const dates = [fmtESPN(now), fmtESPN(tomorrow)];
  const matches = [];

  for (const date of dates) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) { console.warn(`ESPN ${r.status} para ${date}`); continue; }
      const data = await r.json();
      for (const event of (data.events || [])) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const home = comp.competitors?.find(c => c.homeAway === "home");
        const away = comp.competitors?.find(c => c.homeAway === "away");
        if (!home || !away) continue;
        matches.push({
          match: `${home.team?.displayName || "Local"} vs ${away.team?.displayName || "Visitante"}`,
          home: home.team?.displayName || "Local",
          away: away.team?.displayName || "Visitante",
          date: event.date ? new Date(event.date).toISOString().split("T")[0] : fmtISO(now),
          venue: [comp.venue?.fullName, comp.venue?.address?.city].filter(Boolean).join(", "),
          round: comp.notes?.[0]?.headline || event.name || "",
          home_record: home.records?.[0]?.summary || "",
          away_record: away.records?.[0]?.summary || "",
        });
      }
    } catch (e) {
      console.warn(`ESPN error ${date}:`, e.message);
    }
  }

  // Fallback a fixtures.json
  if (matches.length === 0) {
    try {
      const raw = fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf-8");
      const fd = JSON.parse(raw);
      const todayISO = fmtISO(now);
      const tomorrowISO = fmtISO(tomorrow);
      return (fd.matches || []).filter(m => m.date === todayISO || m.date === tomorrowISO);
    } catch { return []; }
  }
  return matches;
}

// ─── Groq ─────────────────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "Eres un analista profesional de apuestas deportivas. Responde SIEMPRE con JSON válido y nada más. Sin markdown ni texto fuera del JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Groq devolvió respuesta vacía");
  return text;
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const r = await fetch(
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
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error(`Gemini vacío. FinishReason: ${data?.candidates?.[0]?.finishReason}`);
  return text;
}

// ─── Extraer array JSON ───────────────────────────────────────────────────────
function extractArray(text) {
  let clean = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  const fb = clean.indexOf("{"), lb = clean.lastIndexOf("}");
  const fk = clean.indexOf("["), lk = clean.lastIndexOf("]");
  if (fb !== -1 && lb !== -1 && (fk === -1 || fb < fk)) clean = clean.substring(fb, lb + 1);
  else if (fk !== -1 && lk !== -1) clean = clean.substring(fk, lk + 1);
  try {
    const p = JSON.parse(clean);
    if (Array.isArray(p)) return p;
    return p.analyses || p.fights || p.picks || p.predictions || null;
  } catch (e) {
    console.error("JSON parse error:", e.message, text.substring(0, 300));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches) {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de apuestas de fútbol. Hoy es ${today}.

Analiza estos partidos del Mundial 2026 y entrega EXACTAMENTE 2 picks por partido en mercados DISTINTOS. NO uses solo "quién gana". Prioriza mercados con valor analítico real.

MERCADOS disponibles (elige los 3 con más respaldo para cada partido):
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

Devuelve SOLO JSON válido sin markdown:
{"analyses":[{"match":"A vs B","meta":"Fecha · Sede · Ronda","context":"contexto clave en 1 oración","picks":[{"market":"mercado","selection":"apuesta exacta","odds_estimate":"1.75","confidence":74,"reasoning":"2-3 oraciones con respaldo táctico específico","edge":"ventaja analítica en 1 frase"},{"market":"segundo mercado","selection":"apuesta","odds_estimate":"1.90","confidence":68,"reasoning":"razonamiento","edge":"edge"}],"risk":"riesgo principal en 1 oración"}]}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de MMA y apuestas. Hoy es ${today}.

Busca el cartel de UFC más próximo (este fin de semana o próximos 7 días). Para el main event y 3-4 peleas importantes, entrega EXACTAMENTE 2 picks por pelea en mercados DISTINTOS.

MERCADOS disponibles (elige los 3 con más respaldo):
- Método de victoria: KO/TKO, Sumisión, Decisión unánime, Decisión dividida
- Over/Under de rounds
- Llega al round X Sí/No
- Pelea va a distancia Sí/No
- Ganador por decisión
- Knockdown en la pelea Sí/No

Devuelve SOLO JSON válido sin markdown:
{"fights":[{"fight":"A vs B","title":null,"weight_class":"división","event":"UFC XXX","date":"YYYY-MM-DD","venue":"Sede, Ciudad","context":"contexto en 1 oración","picks":[{"market":"mercado","selection":"apuesta exacta","odds_estimate":"1.85","confidence":76,"reasoning":"2-3 oraciones con métricas reales","edge":"ventaja analítica en 1 frase"},{"market":"segundo mercado","selection":"apuesta","odds_estimate":"1.65","confidence":71,"reasoning":"razonamiento","edge":"edge"}],"risk":"riesgo principal en 1 oración"}]}`;
}
