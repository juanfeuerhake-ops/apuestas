// /api/picks.js
// Función serverless (Vercel). Se ejecuta en el servidor, nunca en el navegador.

import fs from "fs";
import path from "path";

// ---------- Caché en memoria (TTL de 2 horas) ----------
let cachedPicks = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

export default async function handler(req, res) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Falta la variable de entorno GEMINI_API_KEY."
    });
  }

  try {
    // ---------- 1. Verificar caché ----------
    const now = Date.now();
    if (cachedPicks && (now - cacheTimestamp) < CACHE_TTL_MS) {
      return res.status(200).json(cachedPicks);
    }

    // ---------- 2. Leer fixtures.json ----------
    const fixturesPath = path.join(process.cwd(), "fixtures.json");
    const raw = fs.readFileSync(fixturesPath, "utf-8");
    const data = JSON.parse(raw);

    const matches = data.matches || [];

    if (matches.length === 0) {
      return res.status(200).json({
        picks: [],
        message: "No hay partidos cargados en fixtures.json."
      });
    }

    // ---------- 3. Construir prompt para Gemini ----------
    const prompt = buildPrompt(matches, data.updated);

    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    // ---------- 4. Verificar respuesta HTTP ----------
    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      return res.status(502).json({
        error: `Error de la API de Gemini (HTTP ${geminiRes.status})`,
        details: errBody,
      });
    }

    const geminiData = await geminiRes.json();

    const text =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!text) {
      return res.status(500).json({
        error: "Respuesta vacía de Gemini",
        raw: geminiData,
      });
    }

    // Extraer JSON de forma robusta localizando llaves o corchetes
    let clean = text.trim();
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    const firstBracket = clean.indexOf('[');
    const lastBracket = clean.lastIndexOf(']');

    if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      clean = clean.substring(firstBrace, lastBrace + 1);
    } else if (firstBracket !== -1 && lastBracket !== -1) {
      clean = clean.substring(firstBracket, lastBracket + 1);
    }

    let picks;
    try {
      picks = JSON.parse(clean);
    } catch (e) {
      console.error("Error al parsear el JSON de Gemini:", e);
      console.error("Texto original de Gemini:", text);
      return res.status(500).json({ 
        error: "No se pudo parsear la respuesta de Gemini", 
        raw: text 
      });
    }

    // Gemini puede devolver { "picks": [...] } o directamente [...].
    // Normalizamos para que siempre sea un array.
    let picksArray;
    if (Array.isArray(picks)) {
      picksArray = picks;
    } else if (Array.isArray(picks.picks)) {
      picksArray = picks.picks;
    } else {
      return res.status(500).json({ error: "Formato inesperado de Gemini", raw: picks });
    }

    const result = { picks: picksArray, updated: data.updated };

    // ---------- 5. Guardar en caché ----------
    cachedPicks = result;
    cacheTimestamp = Date.now();

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildPrompt(matches, updated) {
  return `Analista deportivo. Datos de partidos del Mundial 2026 (actualizado ${updated}).

Para cada partido da 1-2 picks con: market, selection, odds_estimate (string, estimación), confidence (15-92, nunca 100/menor 15), reasons (2-3 strings basados SOLO en home_form/away_form/notes dados), risk (string).

Si home_form o away_form es null, confidence 15-30 y dilo en reasons. Sé breve y conciso en cada reason (máx 25 palabras).

Partidos:
${JSON.stringify(matches)}

Responde SOLO JSON:
{"picks":[{"match":"A vs B","meta":"Fecha · Hora · Sede · Grupo","confidence":65,"selections":[{"market":"...","selection":"...","odds_estimate":"1.40"}],"reasons":["...","..."],"risk":"..."}]}`;
}
