// /api/debug.js
// Endpoint temporal SOLO para diagnóstico. Bórralo después de resolver el problema.

export default function handler(req, res) {
  const sportsKey = process.env.SPORTS_API_KEY || "";
  const geminiKey = process.env.GEMINI_API_KEY || "";

  res.status(200).json({
    sports_key_exists: sportsKey.length > 0,
    sports_key_length: sportsKey.length,
    sports_key_preview: sportsKey ? `${sportsKey.slice(0, 4)}...${sportsKey.slice(-4)}` : null,
    gemini_key_exists: geminiKey.length > 0,
    gemini_key_length: geminiKey.length,
  });
}
