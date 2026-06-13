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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
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
  return `Eres un analista deportivo. Te paso una lista de próximos partidos del Mundial 2026 con contexto (fecha, sede, grupo, y notas sobre el nivel/forma de cada selección cuando esté disponible). Estos datos fueron actualizados el ${updated}.

Para cada partido, propone 1-2 "picks" (mercados de apuesta) con:
- market: nombre del mercado (ej "Doble oportunidad", "Over/Under goles", "Ambos anotan")
- selection: la selección concreta del pick
- odds_estimate: una cuota estimada razonable (string, ej "1.35") - deja claro que es una ESTIMACIÓN, no cuota real de casa de apuestas
- confidence: número 15-92 (nunca 100, nunca menor a 15) que representa cuántas señales de contexto respaldan el pick
- reasons: array de 2-4 strings, cada uno explicando una razón concreta basada en el contexto que tienes (jerarquía, experiencia mundialista, estilo de juego, etc.)
- risk: un string explicando el principal riesgo/razón por la que el pick podría fallar

Reglas:
- Basa el razonamiento SOLO en la información de contexto proporcionada (home_form, away_form, notes). No inventes lesiones, alineaciones titulares ni estadísticas que no tengas.
- Si para un partido home_form o away_form es null (rival aún por definir, ej. repechajes), dilo explícitamente y asigna confianza baja (15-30), o puedes omitir ese partido si no hay nada útil que decir.
- Sé honesto: ningún pick es 100% seguro. Resultados de Mundial son impredecibles incluso con clara diferencia de jerarquía.

Partidos:
${JSON.stringify(matches, null, 2)}

Responde ÚNICAMENTE con un JSON válido, sin texto adicional, con esta forma exacta:
{
  "picks": [
    {
      "match": "Equipo A vs Equipo B",
      "meta": "Fecha · Hora · Sede · Grupo",
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
