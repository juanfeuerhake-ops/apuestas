// /api/picks.js
// Función serverless (Vercel). Se ejecuta en el servidor, nunca en el navegador.
//
// Flujo:
// 1. Lee fixtures.json (partidos próximos, actualizado manualmente cada 1-2 días).
// 2. Construye un prompt con esos datos y se lo manda a Gemini.
// 3. Gemini devuelve un JSON con picks + razonamiento, en el formato que el frontend espera.
// 4. Devolvemos ese JSON al frontend.
//
// Para actualizar los partidos: edita /fixtures.json en el repo y haz commit.
// No requiere ninguna API deportiva externa.

import fs from "fs";
import path from "path";

export default async function handler(req, res) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Falta la variable de entorno GEMINI_API_KEY."
    });
  }

  try {
    // ---------- 1. Leer fixtures.json ----------
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

    // ---------- 2. Construir prompt para Gemini ----------
    const prompt = buildPrompt(matches, data.updated);

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 2048,
          },
        }),
      }
    );

    const geminiData = await geminiRes.json();

    const text =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!text) {
      return res.status(500).json({
        error: "Respuesta inválida de Gemini",
        raw: geminiData,
      });
    }

    const clean = text.replace(/```json|```/g, "").trim();

    let picks;
    try {
      picks = JSON.parse(clean);
    } catch (e) {
      return res.status(500).json({ error: "No se pudo parsear la respuesta de Gemini", raw: text });
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

    return res.status(200).json({ picks: picksArray, updated: data.updated });
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
