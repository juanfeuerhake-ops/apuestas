// scripts/update-fixtures.js
// Corre cada día vía GitHub Actions.
// Filtra los partidos del Mundial 2026 para hoy y mañana,
// pide a Gemini contexto/forma de cada selección,
// y escribe fixtures.json actualizado.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// =============================================
// CALENDARIO COMPLETO FASE DE GRUPOS - MUNDIAL 2026
// Fechas en UTC-6 (hora México)
// =============================================
const CALENDAR = [
  // --- Grupo A ---
  { match: "México vs Sudáfrica", date: "2026-06-11", time_mx: "13:00", venue: "Estadio Azteca, Ciudad de México", group: "Grupo A" },
  { match: "Corea del Sur vs Ganador Repechaje UEFA D", date: "2026-06-11", time_mx: "20:00", venue: "Estadio Akron, Guadalajara", group: "Grupo A" },
  { match: "Ganador UEFA D vs Sudáfrica", date: "2026-06-18", time_mx: "10:00", venue: "Mercedes-Benz Stadium, Atlanta", group: "Grupo A" },
  { match: "México vs Corea del Sur", date: "2026-06-18", time_mx: "19:00", venue: "Estadio Akron, Guadalajara", group: "Grupo A" },
  { match: "Ganador UEFA D vs México", date: "2026-06-24", time_mx: "19:00", venue: "Estadio Azteca, Ciudad de México", group: "Grupo A" },
  { match: "Sudáfrica vs Corea del Sur", date: "2026-06-24", time_mx: "19:00", venue: "Estadio BBVA, Guadalupe", group: "Grupo A" },

  // --- Grupo B ---
  { match: "Canadá vs Ganador Repechaje UEFA A", date: "2026-06-12", time_mx: "13:00", venue: "BMO Field, Toronto", group: "Grupo B" },
  { match: "Qatar vs Suiza", date: "2026-06-13", time_mx: "13:00", venue: "Levi's Stadium, Santa Clara", group: "Grupo B" },
  { match: "Suiza vs Ganador UEFA A", date: "2026-06-18", time_mx: "13:00", venue: "SoFi Stadium, Inglewood", group: "Grupo B" },
  { match: "Canadá vs Qatar", date: "2026-06-18", time_mx: "16:00", venue: "BC Place, Vancouver", group: "Grupo B" },
  { match: "Ganador UEFA A vs Qatar", date: "2026-06-24", time_mx: "19:00", venue: "BC Place, Vancouver", group: "Grupo B" },
  { match: "Suiza vs Canadá", date: "2026-06-24", time_mx: "19:00", venue: "Levi's Stadium, Santa Clara", group: "Grupo B" },

  // --- Grupo C ---
  { match: "Brasil vs Marruecos", date: "2026-06-13", time_mx: "16:00", venue: "MetLife Stadium, East Rutherford", group: "Grupo C" },
  { match: "Haití vs Escocia", date: "2026-06-13", time_mx: "19:00", venue: "Gillette Stadium, Foxborough", group: "Grupo C" },
  { match: "Escocia vs Marruecos", date: "2026-06-19", time_mx: "10:00", venue: "Gillette Stadium, Foxborough", group: "Grupo C" },
  { match: "Brasil vs Haití", date: "2026-06-19", time_mx: "13:00", venue: "MetLife Stadium, East Rutherford", group: "Grupo C" },
  { match: "Escocia vs Brasil", date: "2026-06-24", time_mx: "19:00", venue: "Levi's Stadium, Santa Clara", group: "Grupo C" },
  { match: "Marruecos vs Haití", date: "2026-06-24", time_mx: "19:00", venue: "Gillette Stadium, Foxborough", group: "Grupo C" },

  // --- Grupo D ---
  { match: "Estados Unidos vs Paraguay", date: "2026-06-12", time_mx: "19:00", venue: "SoFi Stadium, Inglewood", group: "Grupo D" },
  { match: "Australia vs Türkiye", date: "2026-06-13", time_mx: "22:00", venue: "BC Place, Vancouver", group: "Grupo D" },
  { match: "Estados Unidos vs Australia", date: "2026-06-19", time_mx: "16:00", venue: "Lumen Field, Seattle", group: "Grupo D" },
  { match: "Türkiye vs Paraguay", date: "2026-06-19", time_mx: "19:00", venue: "AT&T Stadium, Arlington", group: "Grupo D" },
  { match: "Türkiye vs Estados Unidos", date: "2026-06-25", time_mx: "19:00", venue: "SoFi Stadium, Inglewood", group: "Grupo D" },
  { match: "Paraguay vs Australia", date: "2026-06-25", time_mx: "19:00", venue: "BC Place, Vancouver", group: "Grupo D" },

  // --- Grupo E ---
  { match: "Alemania vs Curazao", date: "2026-06-14", time_mx: "11:00", venue: "NRG Stadium, Houston", group: "Grupo E" },
  { match: "Costa de Marfil vs Ecuador", date: "2026-06-14", time_mx: "17:00", venue: "Lincoln Financial Field, Philadelphia", group: "Grupo E" },
  { match: "Alemania vs Costa de Marfil", date: "2026-06-20", time_mx: "10:00", venue: "NRG Stadium, Houston", group: "Grupo E" },
  { match: "Ecuador vs Curazao", date: "2026-06-20", time_mx: "13:00", venue: "Lincoln Financial Field, Philadelphia", group: "Grupo E" },
  { match: "Ecuador vs Alemania", date: "2026-06-25", time_mx: "19:00", venue: "NRG Stadium, Houston", group: "Grupo E" },
  { match: "Curazao vs Costa de Marfil", date: "2026-06-25", time_mx: "19:00", venue: "Lincoln Financial Field, Philadelphia", group: "Grupo E" },

  // --- Grupo F ---
  { match: "Países Bajos vs Japón", date: "2026-06-14", time_mx: "14:00", venue: "AT&T Stadium, Arlington", group: "Grupo F" },
  { match: "Túnez vs Ganador Repechaje UEFA B", date: "2026-06-15", time_mx: "10:00", venue: "Estadio BBVA, Guadalupe", group: "Grupo F" },
  { match: "Japón vs Túnez", date: "2026-06-20", time_mx: "16:00", venue: "AT&T Stadium, Arlington", group: "Grupo F" },
  { match: "Ganador UEFA B vs Países Bajos", date: "2026-06-20", time_mx: "19:00", venue: "NRG Stadium, Houston", group: "Grupo F" },
  { match: "Túnez vs Países Bajos", date: "2026-06-25", time_mx: "19:00", venue: "AT&T Stadium, Arlington", group: "Grupo F" },
  { match: "Japón vs Ganador UEFA B", date: "2026-06-26", time_mx: "01:00", venue: "Estadio BBVA, Guadalupe", group: "Grupo F" },

  // --- Grupo G ---
  { match: "Bélgica vs Egipto", date: "2026-06-15", time_mx: "13:00", venue: "Lumen Field, Seattle", group: "Grupo G" },
  { match: "Irán vs Nueva Zelanda", date: "2026-06-15", time_mx: "19:00", venue: "SoFi Stadium, Inglewood", group: "Grupo G" },
  { match: "Bélgica vs Irán", date: "2026-06-21", time_mx: "10:00", venue: "Lumen Field, Seattle", group: "Grupo G" },
  { match: "Nueva Zelanda vs Egipto", date: "2026-06-21", time_mx: "13:00", venue: "Lincoln Financial Field, Philadelphia", group: "Grupo G" },
  { match: "Egipto vs Irán", date: "2026-06-26", time_mx: "19:00", venue: "Lumen Field, Seattle", group: "Grupo G" },
  { match: "Nueva Zelanda vs Bélgica", date: "2026-06-26", time_mx: "19:00", venue: "Lincoln Financial Field, Philadelphia", group: "Grupo G" },

  // --- Grupo H ---
  { match: "España vs Cabo Verde", date: "2026-06-15", time_mx: "10:00", venue: "Mercedes-Benz Stadium, Atlanta", group: "Grupo H" },
  { match: "Arabia Saudita vs Uruguay", date: "2026-06-15", time_mx: "16:00", venue: "Hard Rock Stadium, Miami", group: "Grupo H" },
  { match: "España vs Arabia Saudita", date: "2026-06-21", time_mx: "16:00", venue: "Mercedes-Benz Stadium, Atlanta", group: "Grupo H" },
  { match: "Uruguay vs Cabo Verde", date: "2026-06-21", time_mx: "19:00", venue: "Hard Rock Stadium, Miami", group: "Grupo H" },
  { match: "Arabia Saudita vs Cabo Verde", date: "2026-06-26", time_mx: "19:00", venue: "Hard Rock Stadium, Miami", group: "Grupo H" },
  { match: "Uruguay vs España", date: "2026-06-26", time_mx: "19:00", venue: "Mercedes-Benz Stadium, Atlanta", group: "Grupo H" },

  // --- Grupo I ---
  { match: "Francia vs Senegal", date: "2026-06-15", time_mx: "13:00", venue: "MetLife Stadium, East Rutherford", group: "Grupo I" },
  { match: "Noruega vs Iraq", date: "2026-06-15", time_mx: "19:00", venue: "Gillette Stadium, Foxborough", group: "Grupo I" },
  { match: "Francia vs Noruega", date: "2026-06-21", time_mx: "13:00", venue: "MetLife Stadium, East Rutherford", group: "Grupo I" },
  { match: "Iraq vs Senegal", date: "2026-06-21", time_mx: "16:00", venue: "Gillette Stadium, Foxborough", group: "Grupo I" },
  { match: "Iraq vs Francia", date: "2026-06-26", time_mx: "19:00", venue: "MetLife Stadium, East Rutherford", group: "Grupo I" },
  { match: "Senegal vs Noruega", date: "2026-06-26", time_mx: "19:00", venue: "Gillette Stadium, Foxborough", group: "Grupo I" },

  // --- Grupo J ---
  { match: "Argentina vs Dinamarca", date: "2026-06-16", time_mx: "13:00", venue: "MetLife Stadium, East Rutherford", group: "Grupo J" },
  { match: "Perú vs Gabón", date: "2026-06-16", time_mx: "19:00", venue: "Arrowhead Stadium, Kansas City", group: "Grupo J" },
  { match: "Argentina vs Perú", date: "2026-06-22", time_mx: "13:00", venue: "MetLife Stadium, East Rutherford", group: "Grupo J" },
  { match: "Dinamarca vs Gabón", date: "2026-06-22", time_mx: "16:00", venue: "Arrowhead Stadium, Kansas City", group: "Grupo J" },
  { match: "Dinamarca vs Perú", date: "2026-06-27", time_mx: "19:00", venue: "MetLife Stadium, East Rutherford", group: "Grupo J" },
  { match: "Gabón vs Argentina", date: "2026-06-27", time_mx: "19:00", venue: "Arrowhead Stadium, Kansas City", group: "Grupo J" },

  // --- Grupo K ---
  { match: "Portugal vs Ganador Repechaje UEFA C", date: "2026-06-16", time_mx: "10:00", venue: "Rose Bowl, Pasadena", group: "Grupo K" },
  { match: "Venezuela vs Camerún", date: "2026-06-16", time_mx: "16:00", venue: "Estadio Akron, Guadalajara", group: "Grupo K" },
  { match: "Portugal vs Venezuela", date: "2026-06-22", time_mx: "10:00", venue: "Rose Bowl, Pasadena", group: "Grupo K" },
  { match: "Ganador UEFA C vs Camerún", date: "2026-06-22", time_mx: "19:00", venue: "Estadio Akron, Guadalajara", group: "Grupo K" },
  { match: "Ganador UEFA C vs Portugal", date: "2026-06-27", time_mx: "19:00", venue: "Rose Bowl, Pasadena", group: "Grupo K" },
  { match: "Camerún vs Venezuela", date: "2026-06-27", time_mx: "19:00", venue: "Estadio Akron, Guadalajara", group: "Grupo K" },

  // --- Grupo L ---
  { match: "Inglaterra vs Sudán del Sur", date: "2026-06-17", time_mx: "13:00", venue: "Arrowhead Stadium, Kansas City", group: "Grupo L" },
  { match: "Colombia vs Honduras", date: "2026-06-17", time_mx: "19:00", venue: "Estadio Azteca, Ciudad de México", group: "Grupo L" },
  { match: "Inglaterra vs Colombia", date: "2026-06-23", time_mx: "13:00", venue: "Arrowhead Stadium, Kansas City", group: "Grupo L" },
  { match: "Sudán del Sur vs Honduras", date: "2026-06-23", time_mx: "16:00", venue: "Estadio Azteca, Ciudad de México", group: "Grupo L" },
  { match: "Honduras vs Inglaterra", date: "2026-06-28", time_mx: "19:00", venue: "Arrowhead Stadium, Kansas City", group: "Grupo L" },
  { match: "Colombia vs Sudán del Sur", date: "2026-06-28", time_mx: "19:00", venue: "Estadio Azteca, Ciudad de México", group: "Grupo L" },
];

// Contexto por selección para el análisis
const TEAM_CONTEXT = {
  "México": "Anfitrión del torneo, con presión local, suele salir ofensivo en partidos en casa.",
  "Sudáfrica": "Primera participación mundialista fuera de casa desde 2010, selección africana en crecimiento.",
  "Corea del Sur": "Selección asiática consolidada con jugadores en ligas top europeas, habitual en octavos.",
  "Brasil": "Una de las favoritas del torneo, plantel de élite mundial, suele atacar con amplitud.",
  "Marruecos": "Semifinalista en Qatar 2022, jugadores en clubes top europeos, capaz de generar ocasiones ante cualquier rival.",
  "Haití": "Debuta en su primer Mundial masculino, sin experiencia en esta instancia.",
  "Escocia": "Regresa al Mundial tras proceso exigente europeo, plantel con jugadores en ligas top.",
  "Qatar": "Anfitrión del Mundial 2022, pero con menor ranking internacional, debutante en Mundiales fuera de casa.",
  "Suiza": "Selección europea consolidada, habitual en fases finales, disciplinada tácticamente.",
  "Canadá": "Anfitrión del torneo, primera clasificación mundialista en décadas, genera mucha ilusión local.",
  "Estados Unidos": "Anfitrión del torneo, bajo Pochettino suele generar volumen de ataque por bandas.",
  "Paraguay": "Selección sudamericana competitiva, clasificación sólida en eliminatorias.",
  "Australia": "Selección oceánica consolidada, estilo físico y disciplinado.",
  "Türkiye": "Selección europea con generación joven en ligas top, en crecimiento.",
  "Alemania": "Selección europea candidata histórica, clasificación directa habitual, plantel de élite.",
  "Curazao": "Debuta en su primer Mundial, clasificación histórica vía Concacaf.",
  "Costa de Marfil": "Campeón de la Copa Africana reciente, jugadores en ligas top europeas.",
  "Ecuador": "Selección sudamericana de nivel medio-alto, defensa ordenada.",
  "Países Bajos": "Selección europea de alto nivel, habitual en rondas avanzadas, juego ofensivo.",
  "Japón": "Selección asiática sólida, buen desempeño en mundiales recientes (octavos en 2022).",
  "Túnez": "Selección africana habitual en Mundiales, ordenada defensivamente.",
  "Bélgica": "Selección europea con plantel de nivel top europeo.",
  "Egipto": "Selección africana con jugadores en ligas europeas, competitiva físicamente.",
  "Irán": "Clasificación vía zona asiática, partidos cerrados y disciplinados.",
  "Nueva Zelanda": "Clasificación vía repechaje oceánico, camino históricamente menos competitivo.",
  "España": "Campeona vigente de la Eurocopa, una de las favoritas del torneo, plantel de élite.",
  "Cabo Verde": "Debuta en su primer Mundial, clasificación histórica vía zona africana.",
  "Arabia Saudita": "Sorprendió en Qatar 2022 (venció a Argentina), motivada para repetir.",
  "Uruguay": "Tradición mundialista sudamericana sólida, base defensiva ordenada.",
  "Francia": "Subcampeona en Qatar 2022, plantel de máximo nivel mundial.",
  "Senegal": "Selección africana de buen nivel, jugadores en ligas top europeas.",
  "Noruega": "Selección con Haaland como gran estrella, estilo directo y efectivo.",
  "Iraq": "Clasificación asiática, primera participación en décadas.",
  "Argentina": "Campeona vigente del Mundial 2022, con Messi como referente.",
  "Dinamarca": "Selección europea sólida, semifinalista de la Euro 2020.",
  "Perú": "Selección sudamericana competitiva, clasificación ajustada.",
  "Gabón": "Selección africana emergente.",
  "Portugal": "Selección con plantel de alto nivel, habitual en fases avanzadas.",
  "Venezuela": "Selección en crecimiento en Sudamérica.",
  "Camerún": "Selección africana habitual en Mundiales.",
  "Inglaterra": "Finalista de la Euro 2024, plantel de élite europea.",
  "Sudán del Sur": "Debuta en su primer Mundial.",
  "Colombia": "Selección sudamericana de nivel alto, clasificación sólida.",
  "Honduras": "Selección centroamericana, clasificación vía Concacaf.",
};

function getTeamContext(matchName) {
  const teams = matchName.split(" vs ");
  const home = teams[0]?.trim();
  const away = teams[1]?.trim();
  return {
    home_form: TEAM_CONTEXT[home] || null,
    away_form: TEAM_CONTEXT[away] || null,
  };
}

function getTodayAndTomorrow() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const today = fmt(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  return [today, fmt(tomorrow)];
}

async function main() {
  const [today, tomorrow] = getTodayAndTomorrow();
  console.log(`Buscando partidos para: ${today} y ${tomorrow}`);

  const matches = CALENDAR
    .filter((m) => m.date === today || m.date === tomorrow)
    .map((m) => ({
      ...m,
      ...getTeamContext(m.match),
      notes: null,
    }));

  console.log(`Encontrados: ${matches.length} partidos`);

  if (matches.length === 0) {
    console.log("No hay partidos hoy ni mañana — manteniendo fixtures.json actual.");
    process.exit(0);
  }

  let enrichedMatches = matches;
  if (GEMINI_API_KEY) {
    const prompt = `Eres un analista deportivo del Mundial 2026. Para cada partido, añade una nota (campo "notes") breve (máx 20 palabras) con el contexto más relevante que no está en home_form/away_form (ej: historial directo, contexto del grupo, rival en común). Si no tienes info relevante, deja null.

Partidos:
${JSON.stringify(matches)}

Responde SOLO JSON con el mismo array pero con el campo "notes" rellenado:
[{"match":"...","notes":"...o null"}]`;

    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
          }),
        }
      );

      if (!res.ok) {
        throw new Error(`Gemini API responded with status ${res.status}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const notes = JSON.parse(clean);

      enrichedMatches = matches.map((m) => {
        const note = notes.find((n) => n.match === m.match);
        return { ...m, notes: note?.notes || null };
      });
      console.log("Contexto adicional añadido por Gemini.");
    } catch (e) {
      console.log("No se pudo enriquecer con Gemini, continuing without notes:", e.message);
    }
  }

  const output = {
    updated: today,
    note: "Generado automáticamente por GitHub Actions. No editar manualmente.",
    matches: enrichedMatches,
  };

  const outputPath = path.join(__dirname, "..", "fixtures.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`fixtures.json actualizado con ${enrichedMatches.length} partidos.`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
