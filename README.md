# Scanner de Picks (versión dinámica)

App que muestra picks de apuestas para el Mundial 2026 generados en tiempo real:

1. Trae los partidos de las próximas 48h y la forma reciente de cada selección desde **API-Football**.
2. Manda esos datos a la **API de Claude**, que genera el análisis (índice de confianza, razones, riesgo).
3. El frontend muestra el resultado.

⚠️ **No es una garantía de resultados.** Las cuotas mostradas son estimaciones de IA, no precios reales — verifica siempre en tu casa de apuestas.

---

## 1. Conseguir las API keys

### API-Football (datos deportivos)
1. Crea cuenta en https://www.api-football.com (o vía RapidAPI).
2. Plan gratuito: 100 requests/día — suficiente para uso personal con caché.
3. Copia tu API key.

### Anthropic (análisis con IA)
1. Crea cuenta en https://console.anthropic.com
2. Ve a **API Keys** → **Create Key**.
3. Copia la key (empieza con `sk-ant-...`).
4. Esto tiene costo por uso (unos centavos de USD por cada actualización de picks). Puedes poner un límite de gasto mensual en la configuración de la cuenta.

---

## 2. Subir el proyecto a GitHub

1. Crea un repo nuevo (puede ser el mismo `apuestas` o uno nuevo).
2. Sube **todo** el contenido de esta carpeta:
   - `index.html`
   - `api/picks.js`
   - `package.json`
   - `README.md`

La carpeta `api/` debe quedar en la **raíz** del repo (no dentro de otra carpeta).

---

## 3. Desplegar en Vercel

1. Crea cuenta gratis en https://vercel.com (puedes entrar con tu cuenta de GitHub).
2. Click en **Add New → Project**.
3. Selecciona tu repo.
4. Antes de hacer deploy, ve a **Environment Variables** y agrega:
   - `SPORTS_API_KEY` = tu key de API-Football
   - `ANTHROPIC_API_KEY` = tu key de Anthropic
5. Click en **Deploy**.

En 1-2 minutos tendrás una URL tipo `https://tu-proyecto.vercel.app` — esa es tu app funcionando con datos en vivo.

---

## 4. Actualizaciones futuras

- Cada vez que abras la página, o presiones "Actualizar picks", se hace una nueva consulta a las APIs (esto consume tu cuota gratuita y genera un pequeño costo en Anthropic).
- Si cambias el código y haces `git push`, Vercel vuelve a desplegar automáticamente.

---

## Notas y límites

- El análisis depende de la calidad de los datos de "forma reciente" que devuelva API-Football. Para selecciones que no jugaron amistosos recientes, el modelo lo indicará y bajará la confianza.
- Si superas el límite gratuito de API-Football (100 req/día), la función devolverá error hasta el día siguiente. Para uso personal esto rara vez es un problema si no recargas la página constantemente.
- Considera agregar caché (ej. guardar el resultado por 1-2 horas) si planeas compartir la app con más gente, para no agotar la cuota gratuita.
