# Scanner de Picks (Mundial 2026)

App que muestra picks de apuestas para el Mundial 2026 generados en tiempo real:

1. Lee `fixtures.json` con los partidos de la fase de grupos y el contexto de cada selección.
2. Manda esos datos a la **API de Gemini** (Google), que genera el análisis (índice de confianza, razones, riesgo).
3. El frontend muestra el resultado.

⚠️ **No es una garantía de resultados.** Las cuotas mostradas son estimaciones de IA, no precios reales — verifica siempre en tu casa de apuestas.

---

## 1. Conseguir la API key

### Gemini (análisis con IA)
1. Crea cuenta en https://aistudio.google.com
2. Ve a **Get API Key** → **Create API Key**.
3. Copia la key.
4. Esto tiene costo por uso (centavos de USD por cada actualización de picks). El plan gratuito incluye un número generoso de requests diarios.

---

## 2. Subir el proyecto a GitHub

1. Crea un repo nuevo (puede ser el mismo `apuestas` o uno nuevo).
2. Sube **todo** el contenido de esta carpeta:
   - `index.html`
   - `api/picks.js`
   - `fixtures.json`
   - `manifest.json`
   - `icon-192.png`
   - `icon-512.png`
   - `sw.js`
   - `package.json`
   - `README.md`

La carpeta `api/` debe quedar en la **raíz** del repo (no dentro de otra carpeta).

---

## 3. Desplegar en Vercel

1. Crea cuenta gratis en https://vercel.com (puedes entrar con tu cuenta de GitHub).
2. Click en **Add New → Project**.
3. Selecciona tu repo.
4. Antes de hacer deploy, ve a **Environment Variables** y agrega:
   - `GEMINI_API_KEY` = tu key de Gemini
5. Click en **Deploy**.

En 1-2 minutos tendrás una URL tipo `https://tu-proyecto.vercel.app` — esa es tu app funcionando.

---

## 4. Actualizar datos de partidos

### Opción A: Manual
Edita `fixtures.json` directamente en el repo y haz commit. El formato esperado es:
```json
{
  "updated": "2026-06-14",
  "matches": [
    {
      "match": "Equipo A vs Equipo B",
      "date": "2026-06-14",
      "time_mx": "13:00",
      "venue": "Estadio, Ciudad",
      "group": "Grupo X",
      "home_form": "Contexto del equipo local o null",
      "away_form": "Contexto del equipo visitante o null",
      "notes": null
    }
  ]
}
