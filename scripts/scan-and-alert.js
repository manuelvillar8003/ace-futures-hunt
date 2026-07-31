// ACE FUTURES HUNT — Server-seitiger Scanner (GitHub Actions statt Netlify Scheduled Functions,
// nachdem Netlify Functions bei uns aus unklaren Gruenden nie zuverlaessig ausgeloest haben).
// Laeuft alle 5 Minuten via .github/workflows/scan-and-alert.yml

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MIN_GRADE = process.env.MIN_GRADE || "B";
const STATE_FILE = path.join(__dirname, "..", "alert-state.json");

const GRADE_RANK = { "A+": 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
const MEME_KEYWORDS = ["INU","MOON","ELON","DOGE","SHIB","PEPE","FLOKI","BABY","SAFEMOON","WOJAK","CHAD","1000","MINI"];
const EXCLUDE_BASE = ["USDC","FDUSD","TUSD","DAI","USDP","EUR","TRY","BUSD","USD1"];

function memeScore(symbol) {
  const base = symbol.replace("USDT", "");
  let hits = 0;
  MEME_KEYWORDS.forEach((k) => { if (base.includes(k)) hits++; });
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

function analyzeSmartMoney(klines) {
  let totalVol = 0, buyVol = 0;
  klines.slice(-48).forEach((k) => { totalVol += parseFloat(k[5]); buyVol += parseFloat(k[9]); });
  const buyRatio = totalVol > 0 ? buyVol / totalVol : 0.5;
  let points = 0;
  if (buyRatio > 0.56) points = 1; else if (buyRatio < 0.44) points = -1;
  return { buyRatio, points };
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

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  console.log("Scan startet. MIN_GRADE =", MIN_GRADE, "| Token gesetzt:", !!TOKEN, "| Chat-ID gesetzt:", !!CHAT_ID);
  if (!TOKEN || !CHAT_ID) {
    console.error("TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt.");
    process.exit(1);
  }

  const minRank = GRADE_RANK[MIN_GRADE] ?? GRADE_RANK.B;

  const [tickerRes, fundingRes] = await Promise.all([
    fetch("https://fapi.binance.com/fapi/v1/ticker/24hr"),
    fetch("https://fapi.binance.com/fapi/v1/premiumIndex"),
  ]);
  const tickerData = await tickerRes.json();
  const fundingData = await fundingRes.json();
  console.log(`Ticker-Einträge: ${Array.isArray(tickerData) ? tickerData.length : "KEIN ARRAY: " + JSON.stringify(tickerData).slice(0,200)}`);

  const fundingMap = {};
  fundingData.forEach((f) => { fundingMap[f.symbol] = parseFloat(f.lastFundingRate) * 100; });

  const filtered = tickerData.filter((d) => {
    if (!d.symbol.endsWith("USDT")) return false;
    const base = d.symbol.slice(0, -4);
    if (EXCLUDE_BASE.includes(base)) return false;
    if (parseFloat(d.quoteVolume) < 100000) return false;
    return true;
  });
  console.log(`Nach Filter: ${filtered.length} Paare`);

  const maxVol = Math.max(...filtered.map((d) => parseFloat(d.quoteVolume)));
  const candidates = filtered
    .map((d) => {
      const pct = Math.abs(parseFloat(d.priceChangePercent));
      const volScore = Math.log10(parseFloat(d.quoteVolume) + 1) / Math.log10(maxVol + 1);
      const funding = fundingMap[d.symbol];
      const fundingSignal = funding !== undefined ? Math.abs(funding) : 0;
      const quickScore = pct * 0.6 + volScore * 30 + fundingSignal * 200;
      return { symbol: d.symbol, price: parseFloat(d.lastPrice), quickScore, volScore, meme: memeScore(d.symbol) };
    })
    .sort((a, b) => b.quickScore - a.quickScore)
    .slice(0, 20);
  console.log("Top-Kandidaten:", candidates.map((c) => c.symbol).join(", "));

  const results = await Promise.all(
    candidates.map(async (c) => {
      try {
        const klinesRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${c.symbol}&interval=1h&limit=150`);
        const klines = await klinesRes.json();
        const highs = klines.map((k) => parseFloat(k[2]));
        const lows = klines.map((k) => parseFloat(k[3]));
        const closes = klines.map((k) => parseFloat(k[4]));

        const trend = analyzeTrend(closes);
        const structure = analyzeStructure(highs, lows);
        const smartMoney = analyzeSmartMoney(klines);
        const volatility = analyzeVolatility(highs, lows, closes);
        const funding = fundingMap[c.symbol];

        let fundingPoints = 0;
        if (funding !== undefined) {
          if (funding > 0.05) fundingPoints = -1;
          else if (funding > 0.02) fundingPoints = -0.5;
          else if (funding < -0.05) fundingPoints = 1;
          else if (funding < -0.02) fundingPoints = 0.5;
        }

        const totalScore = trend.points + structure.points + smartMoney.points + fundingPoints;
        const grade = gradeFromScore(totalScore, 4);
        const bias = totalScore >= 1.2 ? "LONG" : totalScore <= -1.2 ? "SHORT" : "NEUTRAL";

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
  // alte Eintraege aufraeumen
  Object.keys(state).forEach((k) => { if (now - state[k] > TWELVE_HOURS) delete state[k]; });

  let sentCount = 0;
  for (const r of valid) {
    const key = `${r.symbol}|${r.grade}|${r.bias}`;
    if (state[key]) continue;

    const emoji = r.bias === "LONG" ? "🚀" : "🔻";
    const reasonSentence = composeReasonSentence(r.trend, r.structure, r.fundingRaw, r.bias);
    const text =
      `${emoji} ${r.symbol.replace("USDT", "")} ${r.bias} (Server-Scan via GitHub Actions)\n\n` +
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
  console.log(`Fertig. ${sentCount} Nachrichten gesendet.`);
}

main().catch((err) => {
  console.error("Scan komplett fehlgeschlagen:", err);
  process.exit(1);
});
