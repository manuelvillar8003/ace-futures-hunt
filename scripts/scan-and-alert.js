// ACE FUTURES HUNT — Server-seitiger Scanner
// Datenquelle: BYBIT statt Binance, da Binance Cloud-Rechenzentrums-IPs (GitHub Actions,
// Netlify) mit HTTP 451 "restricted location" komplett blockiert. Bybit hat diese
// pauschale Cloud-IP-Sperre nach aktuellem Wissensstand nicht - wird hier empirisch getestet.

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MIN_GRADE = process.env.MIN_GRADE || "B";
const STATE_FILE = path.join(__dirname, "..", "alert-state.json");

const GRADE_RANK = { "A+": 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
const MEME_KEYWORDS = ["INU","MOON","ELON","DOGE","SHIB","PEPE","FLOKI","BABY","SAFEMOON","WOJAK","CHAD","1000","MINI"];

function memeScore(symbol) {
  let hits = 0;
  MEME_KEYWORDS.forEach((k) => { if (symbol.includes(k)) hits++; });
  return Math.min(hits, 3);
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function analyzeTrend(closes) {
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const last = closes[closes.length - 1];
  if (s20 === null || s50 === null) return { label: "Nicht genug Daten", points: 0 };
  if (last > s20 && s20 > s50) return { label: "Aufwärtstrend", points: 1 };
  if (last < s20 && s20 < s50) return { label: "Abwärtstrend", points: -1 };
  return { label: "Seitwärts", points: 0 };
}

function findPivots(highs, lows) {
  const swingHighs = [], swingLows = [];
  for (let i = 3; i < highs.length - 3; i++) {
    if (highs[i] === Math.max(...highs.slice(i - 3, i + 4))) swingHighs.push({ i, price: highs[i] });
    if (lows[i] === Math.min(...lows.slice(i - 3, i + 4))) swingLows.push({ i, price: lows[i] });
  }
  return { swingHighs, swingLows };
}

function analyzeStructure(highs, lows) {
  const { swingHighs, swingLows } = findPivots(highs, lows);
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { label: "Zu wenig Struktur", points: 0, lastSwingHigh: Math.max(...highs.slice(-30)), lastSwingLow: Math.min(...lows.slice(-30)) };
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
  const atr = sma(trs, 14) || closes.at(-1) * 0.01;
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

function composeReasonSentence(trendLabel, structureLabel, funding, bias) {
  const parts = [];
  if (trendLabel.includes("Aufwärts")) parts.push("der Trend zeigt nach oben");
  else if (trendLabel.includes("Abwärts")) parts.push("der Trend zeigt nach unten");
  else parts.push("der Trend ist seitwärts");

  if (structureLabel.includes("Bullisch")) parts.push("die Preisstruktur macht Higher Highs/Higher Lows");
  else if (structureLabel.includes("Bearisch")) parts.push("die Preisstruktur macht Lower Highs/Lower Lows");

  if (funding !== undefined) {
    if (funding > 0.02) parts.push("die Funding Rate ist positiv (Longs zahlen)");
    else if (funding < -0.02) parts.push("die Funding Rate ist negativ (Shorts zahlen)");
  }

  const dirWord = bias === "LONG" ? "für eine Long-Idee" : "für eine Short-Idee";
  return `Zusammengefasst: ${parts.join(", ")} — das spricht ${dirWord}.`;
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
  try {
    if (TOKEN && CHAT_ID) await sendTelegram(text.slice(0, 4000));
  } catch (e) {
    console.error("Konnte Debug-Nachricht nicht senden:", e.message);
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  console.log("Scan startet (Bybit). MIN_GRADE =", MIN_GRADE);
  if (!TOKEN || !CHAT_ID) {
    console.error("TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt.");
    process.exit(1);
  }
  const minRank = GRADE_RANK[MIN_GRADE] ?? GRADE_RANK.B;

  const tickerRes = await fetch("https://api.bybit.com/v5/market/tickers?category=linear");
  console.log("Bybit Ticker HTTP-Status:", tickerRes.status);
  const tickerJson = await tickerRes.json();

  if (tickerJson.retCode !== 0 || !tickerJson.result || !Array.isArray(tickerJson.result.list)) {
    await sendDebug(`🔧 DEBUG: Bybit-Ticker unerwartet: ${JSON.stringify(tickerJson).slice(0, 800)}`);
    process.exit(1);
  }

  const allTickers = tickerJson.result.list.filter((d) => d.symbol.endsWith("USDT"));
  console.log(`Bybit-Ticker-Einträge (USDT-Perp): ${allTickers.length}`);

  const filtered = allTickers.filter((d) => parseFloat(d.turnover24h) > 100000);
  const maxVol = Math.max(...filtered.map((d) => parseFloat(d.turnover24h)));

  const candidates = filtered
    .map((d) => {
      const pct = Math.abs(parseFloat(d.price24hPcnt)) * 100; // Bybit gibt Dezimalbruch, nicht %
      const volScore = Math.log10(parseFloat(d.turnover24h) + 1) / Math.log10(maxVol + 1);
      const funding = parseFloat(d.fundingRate) * 100;
      const fundingSignal = Math.abs(funding);
      const quickScore = pct * 0.6 + volScore * 30 + fundingSignal * 200;
      return { symbol: d.symbol, price: parseFloat(d.lastPrice), funding, quickScore, volScore, meme: memeScore(d.symbol) };
    })
    .sort((a, b) => b.quickScore - a.quickScore)
    .slice(0, 20);
  console.log("Top-Kandidaten:", candidates.map((c) => c.symbol).join(", "));

  const results = await Promise.all(
    candidates.map(async (c) => {
      try {
        const klinesRes = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${c.symbol}&interval=60&limit=150`);
        const klinesJson = await klinesRes.json();
        if (klinesJson.retCode !== 0 || !klinesJson.result || !Array.isArray(klinesJson.result.list)) {
          console.log(`Kline-Fehler bei ${c.symbol}:`, JSON.stringify(klinesJson).slice(0, 200));
          return null;
        }
        // Bybit liefert neueste zuerst -> umdrehen fuer chronologische Reihenfolge
        const rows = [...klinesJson.result.list].reverse();
        const highs = rows.map((k) => parseFloat(k[2]));
        const lows = rows.map((k) => parseFloat(k[3]));
        const closes = rows.map((k) => parseFloat(k[4]));
        if (closes.length < 55) return null;

        const trend = analyzeTrend(closes);
        const structure = analyzeStructure(highs, lows);
        const volatility = analyzeVolatility(highs, lows, closes);
        const funding = c.funding;

        let fundingPoints = 0;
        if (funding > 0.05) fundingPoints = -1;
        else if (funding > 0.02) fundingPoints = -0.5;
        else if (funding < -0.05) fundingPoints = 1;
        else if (funding < -0.02) fundingPoints = 0.5;

        const totalScore = trend.points + structure.points + fundingPoints;
        const grade = gradeFromScore(totalScore, 3);
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

        const riskFlags = (atr / entry > 0.03 ? 1 : 0) + (c.volScore < 0.3 ? 1 : 0) + (c.meme > 0 ? 1 : 0);
        const riskLevel = riskFlags >= 2 ? "Hoch" : riskFlags === 1 ? "Mittel" : "Niedrig";

        return {
          symbol: c.symbol, grade, bias, trend: trend.label, structure: structure.label,
          fundingRaw: funding, riskLevel, entry, stopRef, tp1, tp2, tp3, rr1, rr2, rr3,
        };
      } catch (err) {
        console.log(`Fehler bei ${c.symbol}: ${err.message}`);
        return null;
      }
    })
  );

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
    const reasonSentence = composeReasonSentence(r.trend, r.structure, r.fundingRaw, r.bias);
    const text =
      `${emoji} ${r.symbol.replace("USDT", "")} ${r.bias} (Server-Scan via GitHub Actions, Datenquelle Bybit)\n\n` +
      `Note: ${r.grade} · Risiko: ${r.riskLevel}\n\n` +
      `${reasonSentence}\n\n` +
      `Referenz-Level (ATR/Struktur-basiert, keine Empfehlung):\n` +
      `Entry: ${fmtPrice(r.entry)}\nStop: ${fmtPrice(r.stopRef)}\n` +
      `TP1: ${fmtPrice(r.tp1)} (RR ${r.rr1})\nTP2: ${fmtPrice(r.tp2)} (RR ${r.rr2})\nTP3: ${fmtPrice(r.tp3)} (RR ${r.rr3})\n\n` +
      `Kein Finanzrat — eigene Prüfung + eigenes Risikomanagement nötig. ACE FUTURES HUNT`;

    try {
      await sendTelegram(text);
      state[key] = now;
      sentCount++;
    } catch (err) {
      console.log(`Konnte Alert für ${r.symbol} nicht senden: ${err.message}`);
    }
  }

  saveState(state);
  const summary = `Fertig. ${sentCount} Nachrichten gesendet, ${valid.length} Setups gefunden, ${candidates.length} Kandidaten geprüft.`;
  console.log(summary);
  await sendDebug(`🔧 DEBUG (Bybit-Testlauf): ${summary}`);
}

main().catch(async (err) => {
  console.error("Scan komplett fehlgeschlagen:", err);
  await sendDebug(`🔧 DEBUG: Scan-Skript ist komplett abgestürzt:\n\n${err?.stack || err?.message || String(err)}`);
  process.exit(1);
});
