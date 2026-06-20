// /api/picks.js
import fs from "fs";
import path from "path";

let cachedMundial = null;
let cacheMundialTimestamp = 0;
const CACHE_MUNDIAL_TTL_MS = 24 * 60 * 60 * 1000;

let cachedUFC = null;
let cachedUFCWeek = null;

let cachedTenis = null;
let cacheTenisTimestamp = 0;
const CACHE_TENIS_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function getISOWeek(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return monday.toISOString().split("T")[0];
}

// Jerarquía de torneos
const GRAND_SLAMS = ["australian open","roland garros","french open","wimbledon","us open"];
const MASTERS_1000 = ["indian wells","miami open","monte carlo","madrid open","italian open","rome","canada","cincinnati","shanghai","paris masters","rolex paris","monte-carlo"];

export default async function handler(req, res) {
  const GROQ_KEY = process.env.GROQ_UFC_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY) return res.status(500).json({ error: "Falta GROQ_UFC_KEY." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "Falta GEMINI_API_KEY." });

  const now = Date.now();
  let mundialPicks = null;
  let ufcPicks = null;
  let tenisPicks = null;

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
        const BATCH_SIZE = 3;
        const allPicks = [];
        for (let i = 0; i < matches.length; i += BATCH_SIZE) {
          const batch = matches.slice(i, i + BATCH_SIZE);
          try {
            const text = await callGroq(GROQ_KEY, buildMundialPrompt(batch));
            const arr = extractArray(text);
            if (arr && arr.length > 0) allPicks.push(...arr);
          } catch (batchErr) {
            console.warn(`Lote Mundial ${i/BATCH_SIZE + 1} falló:`, batchErr.message);
          }
          if (i + BATCH_SIZE < matches.length) await sleep(1500);
        }
        if (allPicks.length > 0) {
          mundialPicks = { picks: allPicks, updated: new Date().toISOString().split("T")[0] };
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

  // ═══════════════════════════════════════
  // BLOQUE 3: TENIS — ESPN + Groq
  // ═══════════════════════════════════════
  try {
    if (cachedTenis && (now - cacheTenisTimestamp) < CACHE_TENIS_TTL_MS) {
      tenisPicks = cachedTenis;
    } else {
      const { matches: tenisMatches, tournament, tier } = await fetchESPNTenis();
      let tenisText;
      if (tenisMatches.length > 0) {
        // ESPN devolvió partidos — analizar con Groq
        tenisText = await callGroq(GROQ_KEY, buildTenisPrompt(tenisMatches, tournament, tier));
      } else {
        // ESPN no tiene datos — usar Gemini para buscar y analizar
        tenisText = await callGemini(GEMINI_KEY, buildTenisGeminiPrompt());
      }
      const arr = extractArray(tenisText);
      if (arr && arr.length > 0) {
        tenisPicks = { picks: arr, tournament: tournament || "ATP / WTA", tier, updated: new Date().toISOString().split("T")[0] };
        cachedTenis = tenisPicks;
        cacheTenisTimestamp = now;
      } else {
        tenisPicks = { picks: [], message: "La IA no pudo analizar los partidos de tenis." };
      }
    }
  } catch (err) {
    console.error("Error TENIS:", err);
    tenisPicks = { picks: [], message: `Error Tenis: ${String(err?.message || err)}` };
  }

  return res.status(200).json({ mundial: mundialPicks, ufc: ufcPicks, tenis: tenisPicks });
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── ESPN Fútbol ──────────────────────────────────────────────────────────────
async function fetchESPNMatches() {
  const offset = -6;
  const now = new Date(new Date().getTime() + offset * 3600 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const pad = n => String(n).padStart(2, "0");
  const fmtESPN = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}`;
  const fmtISO  = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  const matches = [];

  for (const date of [fmtESPN(now), fmtESPN(tomorrow)]) {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const event of (data.events || [])) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const home = comp.competitors?.find(c => c.homeAway === "home");
        const away = comp.competitors?.find(c => c.homeAway === "away");
        if (!home || !away) continue;
        matches.push({
          match: `${home.team?.displayName || "Local"} vs ${away.team?.displayName || "Visitante"}`,
          date: event.date ? new Date(event.date).toISOString().split("T")[0] : fmtISO(now),
          venue: [comp.venue?.fullName, comp.venue?.address?.city].filter(Boolean).join(", ").substring(0, 40),
          round: (comp.notes?.[0]?.headline || event.name || "").substring(0, 30),
        });
      }
    } catch (e) { console.warn("ESPN fútbol error:", e.message); }
  }

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

// ─── Tenis — wtatennis.com + atptour scraping via livescore API ───────────────
async function fetchESPNTenis() {
  const allMatches = [];
  let detectedTournament = "";
  let detectedTier = "other";

  // Intentar múltiples endpoints de ESPN para tenis
  const endpoints = [
    "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard",
    "https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard",
    "https://site.api.espn.com/apis/site/v2/sports/tennis/atp-singles/scoreboard",
    "https://site.api.espn.com/apis/site/v2/sports/tennis/wta-singles/scoreboard",
    "https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=tennis&league=atp",
    "https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=tennis&league=wta",
  ];

  for (const endpoint of endpoints) {
    try {
      const r = await fetch(endpoint, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) continue;
      const data = await r.json();
      const events = data.events || data.sports?.[0]?.leagues?.[0]?.events || [];
      if (events.length === 0) continue;

      const tour = endpoint.includes("wta") ? "WTA" : "ATP";

      for (const event of events) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const players = comp.competitors || [];
        if (players.length < 2) continue;

        const p1 = players[0]?.athlete?.displayName || players[0]?.team?.displayName || "Jugador 1";
        const p2 = players[1]?.athlete?.displayName || players[1]?.team?.displayName || "Jugador 2";
        const tournamentName = event.season?.slug || event.name || data.leagues?.[0]?.name || "";
        const nameLower = tournamentName.toLowerCase();

        let tier = "other";
        if (GRAND_SLAMS.some(gs => nameLower.includes(gs))) tier = "grandslam";
        else if (MASTERS_1000.some(m => nameLower.includes(m))) tier = "masters1000";

        const p1Rank = players[0]?.athlete?.rank || null;
        const p2Rank = players[1]?.athlete?.rank || null;
        const round = comp.notes?.[0]?.headline || event.shortName || "";
        const status = event.status?.type?.description || "";
        if (status === "Final" || status === "Postponed") continue;

        allMatches.push({ match: `${p1} vs ${p2}`, p1, p2, p1Rank, p2Rank, tournament: tournamentName, tour, round, tier, status });

        if (!detectedTournament && tournamentName) detectedTournament = tournamentName;
        if (tier === "grandslam") detectedTier = "grandslam";
        else if (tier === "masters1000" && detectedTier !== "grandslam") detectedTier = "masters1000";
      }
      if (allMatches.length > 0) break; // endpoint funcionó, no seguir
    } catch (e) {
      console.warn("Tenis endpoint error:", e.message);
    }
  }

  // Si ESPN no devuelve nada, usar Gemini para obtener partidos del día
  if (allMatches.length === 0) {
    return { matches: [], tournament: "", tier: "other" };
  }

  // Filtrar por jerarquía
  let filtered = allMatches;
  if (detectedTier === "grandslam") filtered = allMatches.filter(m => m.tier === "grandslam");
  else if (detectedTier === "masters1000") filtered = allMatches.filter(m => m.tier === "masters1000");
  else {
    filtered = allMatches
      .sort((a, b) => ((a.p1Rank && a.p2Rank) ? -1 : 1))
      .slice(0, 5);
  }

  return { matches: filtered.slice(0, 6), tournament: detectedTournament, tier: detectedTier };
}

// ─── Groq ─────────────────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Eres un analista profesional de apuestas deportivas. Responde SIEMPRE con JSON válido y nada más. Sin markdown ni texto fuera del JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 2048,
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
    const arr = p.analyses || p.fights || p.picks || p.predictions || p.matches || p.tenis;
    if (arr) return arr;
    console.error("JSON sin array. Keys:", Object.keys(p));
    return null;
  } catch (e) {
    console.error("JSON parse error:", e.message, clean.substring(0, 300));
    return null;
  }
}

// ─── Prompt Mundial ──────────────────────────────────────────────────────────
function buildMundialPrompt(matches) {
  const today = new Date().toISOString().split("T")[0];
  const compactMatches = matches.map(m => ({ m: m.match, d: m.date, v: (m.venue||"").substring(0,40), r: (m.round||"").substring(0,30) }));
  return `Analista apuestas fútbol. Hoy: ${today}. Mundial 2026.
2 picks por partido, mercados distintos. No solo ganador.
Mercados: handicap asiático, over/under goles, resultado HT, ambos anotan, corners, tarjetas.
Partidos: ${JSON.stringify(compactMatches)}
JSON: {"analyses":[{"match":"A vs B","meta":"info","context":"1 frase","picks":[{"market":"m","selection":"s","odds_estimate":"1.75","confidence":74,"reasoning":"2 frases","edge":"1 frase"},{"market":"m2","selection":"s2","odds_estimate":"1.90","confidence":68,"reasoning":"2 frases","edge":"1 frase"}],"risk":"1 frase"}]}`;
}

// ─── Prompt UFC ──────────────────────────────────────────────────────────────
function buildUFCPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de MMA y apuestas. Hoy es ${today}.
Busca el cartel de UFC más próximo (este fin de semana o próximos 7 días). Main event y 3-4 peleas importantes. 2 picks por pelea en mercados distintos.
Mercados: método de victoria (KO/TKO/Sumisión/Decisión), over/under rounds, llega al round X, pelea a distancia, knockdown Sí/No.
JSON: {"fights":[{"fight":"A vs B","title":null,"weight_class":"división","event":"UFC XXX","date":"YYYY-MM-DD","venue":"Sede, Ciudad","context":"1 frase","picks":[{"market":"m","selection":"s","odds_estimate":"1.85","confidence":76,"reasoning":"2 frases","edge":"1 frase"},{"market":"m2","selection":"s2","odds_estimate":"1.65","confidence":71,"reasoning":"2 frases","edge":"1 frase"}],"risk":"1 frase"}]}`;
}

// ─── Prompt Tenis via Gemini (cuando ESPN no tiene datos) ────────────────────
function buildTenisGeminiPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `Eres un analista profesional de tenis y apuestas. Hoy es ${today}.

Busca los partidos de tenis más importantes que se juegan HOY. Prioridad: Grand Slam > Masters 1000 > ATP 500 > WTA > otros. Si hay Grand Slam o Masters 1000 en curso, muestra solo esos. Si no, los 5 partidos con mejores oportunidades de apuesta del día.

Para cada partido entrega 2 picks en mercados DISTINTOS al ganador simple.
Mercados: ganador primer set, total games over/under, llega al tercer set Sí/No, total sets over/under, handicap games.

Devuelve SOLO JSON válido:
{"analyses":[{"match":"A vs B","meta":"Torneo · Ronda · ATP/WTA","context":"1 frase sobre el partido","picks":[{"market":"m","selection":"s","odds_estimate":"1.75","confidence":72,"reasoning":"2 frases con respaldo","edge":"1 frase"},{"market":"m2","selection":"s2","odds_estimate":"1.90","confidence":65,"reasoning":"2 frases","edge":"1 frase"}],"risk":"1 frase"}]}`;
}

// ─── Prompt Tenis via Groq (cuando ESPN tiene datos) ──────────────────────────
// ─── Prompt Tenis ─────────────────────────────────────────────────────────────
function buildTenisPrompt(matches, tournament, tier) {
  const today = new Date().toISOString().split("T")[0];
  const tierLabel = tier === "grandslam" ? "Grand Slam" : tier === "masters1000" ? "Masters 1000" : "torneo ATP/WTA";
  const compactMatches = matches.map(m => ({
    m: m.match,
    tour: m.tour,
    round: m.round,
    r1: m.p1Rank ? `#${m.p1Rank}` : "?",
    r2: m.p2Rank ? `#${m.p2Rank}` : "?",
  }));
  return `Analista apuestas tenis. Hoy: ${today}. Torneo: ${tournament || tierLabel} (${tierLabel}).
2 picks por partido en mercados distintos. NO solo ganador del partido.
Mercados disponibles: ganador primer set, total games over/under, llega al tercer set Sí/No, total sets over/under, handicap games, break en primer game.
Partidos (r1/r2 = ranking ATP/WTA): ${JSON.stringify(compactMatches)}
JSON: {"analyses":[{"match":"A vs B","meta":"torneo · ronda · tour","context":"1 frase sobre el partido","picks":[{"market":"m","selection":"s","odds_estimate":"1.75","confidence":72,"reasoning":"2 frases con respaldo estadístico","edge":"1 frase"},{"market":"m2","selection":"s2","odds_estimate":"1.90","confidence":65,"reasoning":"2 frases","edge":"1 frase"}],"risk":"1 frase"}]}`;
}
