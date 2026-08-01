// ACE FUTURES HUNT — Server-seitiger Scanner
// Datenquelle: COINGECKO (nicht Binance/Bybit direkt) - Binance blockiert Cloud-IPs mit HTTP 451,
// Bybit blockiert vermutlich per Cloudflare (HTML statt JSON). CoinGecko ist ein reiner
// Daten-Aggregator, der fuer genau solche Bot-Zugriffe gebaut ist und Cloud-IPs nicht sperrt.
// Kompromiss: keine Funding-Rate (nur boersenspezifisch), dafuer Trend+Struktur aus echten Kursdaten.

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MIN_GRADE = process.env.MIN_GRADE || "B";
const STATE_FILE = path.join(__dirname, "..", "alert-state.json");

const GRADE_RANK = { "A+": 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
const MEME_KEYWORDS = ["inu","moon","elon","doge","shib","pepe","floki","baby","safemoon","wojak","chad"];

function memeScore(symbolLower) {
  let hits = 0;
  MEME_KEYWORDS.forEach((k) => { if (symbolLower.includes(k)) hits++; });
  return Math.min(hits, 3);
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function analyzeTrend(closes) {
  const s5 = sma(closes, 5), s15 = sma(closes, 15);
  const last = closes[closes.length - 1];
  if (s5 === null || s15 === null) return { label: "Nicht genug Daten", points: 0 };
  if (last > s5 && s5 > s15) return { label: "Aufwärtstrend", points: 1 };
  if (last < s5 && s5 < s15) return { label: "Abwärtstrend", points: -1 };
  return { label: "Seitwärts", points: 0 };
}

function findPivots(highs, lows) {
  const swingHighs = [], swingLows = [];
  const w = 2;
  for (let i = w; i < highs.length - w; i++) {
    if (highs[i] === Math.max(...highs.slice(i - w, i + w + 1))) swingHighs.push({ i, price: highs[i] });
    if (lows[i] === Math.min(...lows.slice(i - w, i + w + 1))) swingLows.push({ i, price: lows[i] });
  }
  return { swingHighs, swingLows };
}

function analyzeStructure(highs, lows) {
  const { swingHighs, swingLows } = findPivots(highs, lows);
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { label: "Zu wenig Struktur", points: 0, lastSwingHigh: Math.max(...highs.slice(-10)), lastSwingLow: Math.min(...lows.slice(-10)) };
  }
  const hh = swingHighs.at(-1).price > swingHighs.at(-2).price;
  const hl = swingLows.at(-1).price > swingLows.at(-2).price;
  const lh = swingHighs.at(-1).price < swingHighs.at(-2).price;
  const ll = swingLows.at(-1).price < swingLows.at(-2).price;
  let label, points;
  if (hh && hl) { label = "Bullische Struktur"; points = 1; }
  else if (lh && ll) { label = "Bearische Struktur"; points = -1; }
  else { label = "Range-Struktur"; points = 0; }
  return { label, points, lastSwingHigh: swingHighs.at(-1).price, lastSwingLow: swingLows.at(-1).price };
}

function analyzeVolatility(highs, lows, closes) {
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const atr = sma(trs, Math.min(14, trs.length)) || closes.at(-1) * 0.02;
  return { atr };
}

function gradeFromScore(score, maxScore) {
  const pct = Math.abs(score) / maxScore;
  if (pct >= 0.85) return "A+";
  if (pct >= 0.72) return "A";
  if (pct >= 0.6) return "B";
  if (pct >= 0.48) return "C";
  if (pct >= 0.38) return "D";
  return "F";
}

function fmtPrice(n) {
  if (n === 0 || isNaN(n)) return "0";
  if (n >= 1000) return n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(5);
  const magnitude = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.min(18, Math.max(6, -magnitude + 3));
  return n.toFixed(decimals);
}

function composeReasonSentence(trendLabel, structureLabel, bias) {
  const parts = [];
  if (trendLabel.includes("Aufwärts")) parts.push("der Trend zeigt nach oben");
  else if (trendLabel.includes("Abwärts")) parts.push("der Trend zeigt nach unten");
  else parts.push("der Trend ist seitwärts");
  if (structureLabel.includes("Bullisch")) parts.push("die Preisstruktur macht Higher Highs/Higher Lows");
  else if (structureLabel.includes("Bearisch")) parts.push("die Preisstruktur macht Lower Highs/Lower Lows");
  const dirWord = bias === "LONG" ? "für eine Long-Idee" : "für eine Short-Idee";
  return `Zusammengefasst: ${parts.join(", ")} — das spricht ${dirWord}. (Hinweis: ohne Funding-Rate, da CoinGecko keine Futures-Daten liefert.)`;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  const body = await res.text();
  console.log(`Telegram-Status ${res.status}: ${body}`);
  if (!res.ok) throw new Error(`Telegram lehnte ab: ${body}`);
}
async function sendDebug(text) {
  try { if (TOKEN && CHAT_ID) await sendTelegram(text.slice(0, 4000)); }
  catch (e) { console.error("Konnte Debug-Nachricht nicht senden:", e.message); }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log("Scan startet (CoinGecko). MIN_GRADE =", MIN_GRADE);
  if (!TOKEN || !CHAT_ID) {
    console.error("TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt.");
    process.exit(1);
  }
  const minRank = GRADE_RANK[MIN_GRADE] ?? GRADE_RANK.B;

  const marketsRes = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=30&page=1&price_change_percentage=24h"
  );
  console.log("CoinGecko Markets HTTP-Status:", marketsRes.status);
  const marketsText = await marketsRes.text();
  let markets;
  try {
    markets = JSON.parse(marketsText);
  } catch (e) {
    await sendDebug(`🔧 DEBUG: CoinGecko-Markets kein JSON. Status ${marketsRes.status}. Body: ${marketsText.slice(0, 600)}`);
    process.exit(1);
  }
  if (!Array.isArray(markets)) {
    await sendDebug(`🔧 DEBUG: CoinGecko-Markets unerwartet: ${JSON.stringify(markets).slice(0, 600)}`);
    process.exit(1);
  }
  console.log(`CoinGecko-Einträge: ${markets.length}`);

  const candidates = markets
    .filter((m) => m.total_volume > 500000)
    .map((m) => ({
      id: m.id,
      symbol: m.symbol.toUpperCase(),
      price: m.current_price,
      pct24h: m.price_change_percentage_24h || 0,
      volume: m.total_volume,
      meme: memeScore(m.id),
    }))
    .sort((a, b) => Math.abs(b.pct24h) - Math.abs(a.pct24h))
    .slice(0, 12);
  console.log("Top-Kandidaten:", candidates.map((c) => c.symbol).join(", "));

  const results = [];
  for (const c of candidates) {
    try {
      const ohlcRes = await fetch(`https://api.coingecko.com/api/v3/coins/${c.id}/ohlc?vs_currency=usd&days=14`);
      const ohlcText = await ohlcRes.text();
      let ohlc;
      try { ohlc = JSON.parse(ohlcText); } catch { console.log(`OHLC kein JSON bei ${c.symbol}: ${ohlcText.slice(0,150)}`); results.push(null); await sleep(1500); continue; }
      if (!Array.isArray(ohlc) || ohlc.length < 20) { results.push(null); await sleep(1500); continue; }

      const highs = ohlc.map((k) => k[2]);
      const lows = ohlc.map((k) => k[3]);
      const closes = ohlc.map((k) => k[4]);

      const trend = analyzeTrend(closes);
      const structure = analyzeStructure(highs, lows);
      const volatility = analyzeVolatility(highs, lows, closes);

      const totalScore = trend.points + structure.points;
      const grade = gradeFromScore(totalScore, 2);
      const bias = totalScore >= 1 ? "LONG" : totalScore <= -1 ? "SHORT" : "NEUTRAL";

      const dir = bias === "LONG" ? 1 : bias === "SHORT" ? -1 : 0;
      const atr = volatility.atr;
      const entry = c.price;
      const stopRef = dir >= 0 ? Math.min(entry - atr, structure.lastSwingLow) : Math.max(entry + atr, structure.lastSwingHigh);
      const tp1 = dir >= 0 ? entry + 1.5 * atr : entry - 1.5 * atr;
      const tp2 = dir >= 0 ? entry + 3 * atr : entry - 3 * atr;
      const tp3 = dir >= 0 ? entry + 5 * atr : entry - 5 * atr;
      const stopDist = Math.abs(entry - stopRef) || 1;
      const rr1 = (Math.abs(tp1 - entry) / stopDist).toFixed(2);
      const rr2 = (Math.abs(tp2 - entry) / stopDist).toFixed(2);
      const rr3 = (Math.abs(tp3 - entry) / stopDist).toFixed(2);

      const riskFlags = (atr / entry > 0.04 ? 1 : 0) + (c.meme > 0 ? 1 : 0);
      const riskLevel = riskFlags >= 2 ? "Hoch" : riskFlags === 1 ? "Mittel" : "Niedrig";

      results.push({ symbol: c.symbol, grade, bias, trend: trend.label, structure: structure.label,
        riskLevel, entry, stopRef, tp1, tp2, tp3, rr1, rr2, rr3 });
    } catch (err) {
      console.log(`Fehler bei ${c.symbol}: ${err.message}`);
      results.push(null);
    }
    await sleep(1500); // CoinGecko Free-Tier Rate-Limit schonen
  }

  const valid = results.filter((r) => r && GRADE_RANK[r.grade] >= minRank && r.bias !== "NEUTRAL");
  console.log(`${valid.length} Setups über Schwelle ${MIN_GRADE} gefunden von ${candidates.length} Kandidaten.`);

  const state = loadState();
  const now = Date.now();
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  Object.keys(state).forEach((k) => { if (now - state[k] > TWELVE_HOURS) delete state[k]; });

  let sentCount = 0;
  for (const r of valid) {
    const key = `${r.symbol}|${r.grade}|${r.bias}`;
    if (state[key]) continue;
    const emoji = r.bias === "LONG" ? "🚀" : "🔻";
    const reasonSentence = composeReasonSentence(r.trend, r.structure, r.bias);
    const text =
      `${emoji} ${r.symbol} ${r.bias} (Server-Scan via GitHub Actions, Quelle: CoinGecko)\n\n` +
      `Note: ${r.grade} · Risiko: ${r.riskLevel}\n\n${reasonSentence}\n\n` +
      `Referenz-Level (ATR/Struktur-basiert, keine Empfehlung):\n` +
      `Entry: ${fmtPrice(r.entry)}\nStop: ${fmtPrice(r.stopRef)}\n` +
      `TP1: ${fmtPrice(r.tp1)} (RR ${r.rr1})\nTP2: ${fmtPrice(r.tp2)} (RR ${r.rr2})\nTP3: ${fmtPrice(r.tp3)} (RR ${r.rr3})\n\n` +
      `Kein Finanzrat — eigene Prüfung + eigenes Risikomanagement nötig. ACE FUTURES HUNT`;
    try { await sendTelegram(text); state[key] = now; sentCount++; }
    catch (err) { console.log(`Konnte Alert für ${r.symbol} nicht senden: ${err.message}`); }
  }

  saveState(state);
  const summary = `Fertig. ${sentCount} Nachrichten gesendet, ${valid.length} Setups gefunden, ${candidates.length} Kandidaten geprüft (Quelle: CoinGecko).`;
  console.log(summary);
  await sendDebug(`🔧 DEBUG (CoinGecko-Testlauf): ${summary}`);
}

main().catch(async (err) => {
  console.error("Scan komplett fehlgeschlagen:", err);
  await sendDebug(`🔧 DEBUG: Scan-Skript ist komplett abgestürzt:\n\n${err?.stack || err?.message || String(err)}`);
  process.exit(1);
});
