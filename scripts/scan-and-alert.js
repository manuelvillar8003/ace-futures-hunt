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

function fetchWithRetry(url, options, retries = 2, delayMs = 2000) {
  return fetch(url, options).then(async (res) => {
    if (!res.ok && retries > 0 && (res.status === 429 || res.status >= 500)) {
      console.log(`HTTP ${res.status} bei ${url} — retry in ${delayMs}ms (${retries} Versuche übrig)`);
      await new Promise((r) => setTimeout(r, delayMs));
      return fetchWithRetry(url, options, retries - 1, delayMs * 2);
    }
    return res;
  }).catch(async (err) => {
    if (retries > 0) {
      console.log(`Netzwerkfehler bei ${url} (${err.message}) — retry in ${delayMs}ms (${retries} Versuche übrig)`);
      await new Promise((r) => setTimeout(r, delayMs));
      return fetchWithRetry(url, options, retries - 1, delayMs * 2);
    }
    throw err;
  });
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
  const tips = [];
  if (trendLabel.includes("Aufwärts")) {
    parts.push("der Trend zeigt nach oben (Preis über beiden gleitenden Durchschnitten)");
  } else if (trendLabel.includes("Abwärts")) {
    parts.push("der Trend zeigt nach unten (Preis unter beiden gleitenden Durchschnitten)");
  } else {
    parts.push("der Trend ist seitwärts");
  }
  if (structureLabel.includes("Bullisch")) {
    parts.push("die Preisstruktur macht Higher Highs/Higher Lows");
    tips.push("Higher Highs/Higher Lows heißt: jeder Rücksetzer hält über dem letzten Tief — klassisches Zeichen für intakten Aufwärtstrend, kein reiner Zufalls-Pump.");
  } else if (structureLabel.includes("Bearisch")) {
    parts.push("die Preisstruktur macht Lower Highs/Lower Lows");
    tips.push("Lower Highs/Lower Lows heißt: jede Erholung bleibt unter dem letzten Hoch — klassisches Zeichen für intakten Abwärtstrend.");
  }
  const dirWord = bias === "LONG" ? "für eine Long-Idee" : "für eine Short-Idee";
  let text = `Zusammengefasst: ${parts.join(", ")} — das spricht ${dirWord}.`;
  if (tips.length > 0) text += `\n\n💡 ${tips.join(" ")}`;
  text += `\n\n(Hinweis: ohne Funding-Rate, da CoinGecko keine Futures-Daten liefert — Note beruht nur auf Trend+Struktur.)`;
  return text;
}

function composeStatsLine(tracking) {
  const resolved = tracking.entries.filter((e) => e.resolved);
  if (resolved.length === 0) return "📊 Bisherige Erfolgsquote: noch keine abgeschlossenen Setups (Tracking läuft erst seit kurzem).";
  const wins = resolved.filter((e) => e.resolved.win).length;
  const wr = ((wins / resolved.length) * 100).toFixed(0);
  const cautionNote = resolved.length < 20 ? " (kleine Stichprobe, noch nicht statistisch belastbar)" : "";
  return `📊 Bisherige Erfolgsquote über alle Setups: ${wr}% (${wins}/${resolved.length})${cautionNote}.`;
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
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ================= FORWARD-TRACKING (echte RR-basierte Win-Rate) =================
// Prueft nicht mehr "hat sich der Preis nach X Stunden bewegt", sondern die eigentlich
// relevante Frage: wurde TP1/TP2/TP3 ODER der Stop zuerst erreicht? Laeuft alle 5 Minuten
// mit, prueft bei jedem Durchlauf den aktuellen Preis gegen alle offenen Setups.
const TRACKING_FILE = path.join(__dirname, "..", "tracking-log.json");
const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // nach 7 Tagen ohne Treffer: als EXPIRED schliessen

function loadTracking() {
  try { return JSON.parse(fs.readFileSync(TRACKING_FILE, "utf8")); } catch { return { entries: [] }; }
}
function saveTracking(data) {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
}

// Loggt jedes Setup, das tatsaechlich als Alert rausging (valid), mit allen Referenz-Leveln,
// damit wir spaeter pruefen koennen was zuerst getroffen wurde.
function logNewSetups(alertedResults, tracking) {
  const now = Date.now();
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  let newCount = 0;
  for (const r of alertedResults) {
    if (!r || r.bias === "NEUTRAL") continue;
    const recentDup = tracking.entries.find(
      (e) => e.symbol === r.symbol && e.grade === r.grade && e.bias === r.bias && now - e.loggedAt < TWELVE_HOURS
    );
    if (recentDup) continue;
    tracking.entries.push({
      id: r.id, symbol: r.symbol, grade: r.grade, bias: r.bias,
      entry: r.entry, stopRef: r.stopRef, tp1: r.tp1, tp2: r.tp2, tp3: r.tp3,
      loggedAt: now, resolved: null,
    });
    newCount++;
  }
  if (newCount > 0) console.log(`${newCount} neue Setups zum RR-Tracking hinzugefuegt.`);
}

// Prueft ALLE noch offenen Setups gegen den aktuellen Preis: wurde Stop oder ein TP erreicht?
// Da wir alle 5 Minuten checken, ist die Erkennung praktisch in Echtzeit (kleine Verzoegerung
// durch das Check-Intervall, aber der zuerst erreichte Level wird auch zuerst erkannt).
async function evaluatePendingSetups(tracking) {
  const now = Date.now();
  const open = tracking.entries.filter((e) => !e.resolved);
  if (open.length === 0) { console.log("Keine offenen Setups zum Pruefen."); return; }

  const uniqueIds = [...new Set(open.map((e) => e.id))];
  const priceMap = {};
  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50);
    try {
      const res = await fetchWithRetry(`https://api.coingecko.com/api/v3/simple/price?ids=${batch.join(",")}&vs_currencies=usd`);
      const json = await res.json();
      Object.entries(json).forEach(([id, v]) => { priceMap[id] = v.usd; });
    } catch (err) {
      console.log("Preis-Abfrage fuer Tracking fehlgeschlagen:", err.message);
    }
    await sleep(1500);
  }

  let resolvedCount = 0;
  for (const e of open) {
    const price = priceMap[e.id];
    if (price === undefined) continue;
    const isLong = e.bias === "LONG";

    let outcome = null;
    if (isLong) {
      if (price <= e.stopRef) outcome = "STOP";
      else if (price >= e.tp3) outcome = "TP3";
      else if (price >= e.tp2) outcome = "TP2";
      else if (price >= e.tp1) outcome = "TP1";
    } else {
      if (price >= e.stopRef) outcome = "STOP";
      else if (price <= e.tp3) outcome = "TP3";
      else if (price <= e.tp2) outcome = "TP2";
      else if (price <= e.tp1) outcome = "TP1";
    }

    if (outcome) {
      e.resolved = { outcome, price, resolvedAt: now, win: outcome !== "STOP" };
      resolvedCount++;
    } else if (now - e.loggedAt > MAX_LIFETIME_MS) {
      const pctMove = ((price - e.entry) / e.entry) * 100 * (isLong ? 1 : -1);
      e.resolved = { outcome: "EXPIRED", price, resolvedAt: now, win: pctMove > 0 };
      resolvedCount++;
    }
  }
  if (resolvedCount > 0) console.log(`${resolvedCount} Setups wurden gerade aufgeloest (Stop/TP getroffen oder abgelaufen).`);
}

function computeAndLogStats(tracking) {
  const byGrade = {};
  tracking.entries.forEach((e) => {
    if (!e.resolved) return;
    if (!byGrade[e.grade]) byGrade[e.grade] = { wins: 0, total: 0, tp1: 0, tp2: 0, tp3: 0, stop: 0, expired: 0 };
    const g = byGrade[e.grade];
    g.total++;
    if (e.resolved.win) g.wins++;
    if (e.resolved.outcome === "TP1") g.tp1++;
    if (e.resolved.outcome === "TP2") g.tp2++;
    if (e.resolved.outcome === "TP3") g.tp3++;
    if (e.resolved.outcome === "STOP") g.stop++;
    if (e.resolved.outcome === "EXPIRED") g.expired++;
  });
  console.log("=== ECHTE WIN-RATE (TP/Stop-basiert, aus Forward-Tracking) ===");
  Object.entries(byGrade)
    .sort()
    .forEach(([grade, g]) => {
      const wr = ((g.wins / g.total) * 100).toFixed(0);
      console.log(`  Note ${grade}: ${wr}% Win-Rate (${g.wins}/${g.total}) — TP1:${g.tp1} TP2:${g.tp2} TP3:${g.tp3} Stop:${g.stop} Expired:${g.expired}`);
    });
  return byGrade;
}

async function main() {
  console.log("Scan startet (CoinGecko, BTC/ETH-Fokus). MIN_GRADE =", MIN_GRADE);
  if (!TOKEN || !CHAT_ID) {
    console.error("TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt.");
    process.exit(1);
  }
  const minRank = GRADE_RANK[MIN_GRADE] ?? GRADE_RANK.B;

  const marketsRes = await fetchWithRetry(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&price_change_percentage=24h"
  );
  console.log("CoinGecko Markets HTTP-Status:", marketsRes.status);
  const marketsText = await marketsRes.text();
  let markets;
  try {
    markets = JSON.parse(marketsText);
  } catch (e) {
    console.error(`CoinGecko-Markets kein JSON. Status ${marketsRes.status}. Body: ${marketsText.slice(0, 600)}`);
    process.exit(1);
  }
  if (!Array.isArray(markets)) {
    console.error(`CoinGecko-Markets unerwartet: ${JSON.stringify(markets).slice(0, 600)}`);
    process.exit(1);
  }
  console.log(`CoinGecko-Einträge: ${markets.length}`);

  // Bewusst nur BTC/ETH: liquider, weniger manipulationsanfaellig, zuverlaessigere
  // Auswertung als Low-Cap-Altcoins.
  const candidates = markets.map((m) => ({
    id: m.id,
    symbol: m.symbol.toUpperCase() + "USDT",
    price: m.current_price,
    pct24h: m.price_change_percentage_24h || 0,
    volume: m.total_volume,
    meme: 0,
  }));
  console.log("Kandidaten:", candidates.map((c) => c.symbol).join(", "));

  const results = [];
  for (const c of candidates) {
    try {
      const ohlcRes = await fetchWithRetry(`https://api.coingecko.com/api/v3/coins/${c.id}/ohlc?vs_currency=usd&days=14`);
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

      results.push({ id: c.id, symbol: c.symbol, grade, bias, trend: trend.label, structure: structure.label,
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

  // Tracking zuerst laden + offene Setups auswerten, damit die Win-Rate in der
  // gleich verschickten Nachricht aktuell ist (nicht von letztem Lauf).
  const tracking = loadTracking();
  await evaluatePendingSetups(tracking);
  const statsLine = composeStatsLine(tracking);

  let sentCount = 0;
  for (const r of valid) {
    const key = `${r.symbol}|${r.grade}|${r.bias}`;
    if (state[key]) continue;
    const emoji = r.bias === "LONG" ? "🚀" : "🔻";
    const reasonSentence = composeReasonSentence(r.trend, r.structure, r.bias);
    const text =
      `${emoji} ${r.symbol.replace("USDT","")} ${r.bias} (Server-Scan via GitHub Actions, Quelle: CoinGecko)\n\n` +
      `Note: ${r.grade} · Risiko: ${r.riskLevel}\n\n${reasonSentence}\n\n` +
      `Referenz-Level (ATR/Struktur-basiert, keine Empfehlung):\n` +
      `Entry: ${fmtPrice(r.entry)}\nStop: ${fmtPrice(r.stopRef)}\n` +
      `TP1: ${fmtPrice(r.tp1)} (RR ${r.rr1})\nTP2: ${fmtPrice(r.tp2)} (RR ${r.rr2})\nTP3: ${fmtPrice(r.tp3)} (RR ${r.rr3})\n\n` +
      `${statsLine}\n\n` +
      `ACE FUTURES HUNT`;
    try { await sendTelegram(text); state[key] = now; sentCount++; }
    catch (err) { console.log(`Konnte Alert für ${r.symbol} nicht senden: ${err.message}`); }
  }

  saveState(state);

  // ---- Forward-Tracking: neue verschickte Setups loggen, Datei speichern ----
  logNewSetups(valid, tracking);
  saveTracking(tracking);
  const stats = computeAndLogStats(tracking);

  // Einmal pro Tag (zwischen 8-8:05 Uhr UTC) eine ausfuehrlichere Zusammenfassung schicken.
  const nowDate = new Date();
  if (nowDate.getUTCHours() === 8 && nowDate.getUTCMinutes() < 15 && Object.keys(stats).length > 0) {
    const lines = Object.entries(stats)
      .sort()
      .map(([grade, g]) => {
        const wr = ((g.wins / g.total) * 100).toFixed(0);
        return `Note ${grade}: ${wr}% (${g.wins}/${g.total}) — TP1:${g.tp1} TP2:${g.tp2} TP3:${g.tp3} Stop:${g.stop} Expired:${g.expired}`;
      });
    await sendTelegram(`📊 Tägliche Win-Rate-Statistik (Forward-Tracking, alle bisherigen Setups):\n\n${lines.join("\n")}`);
  }

  const summary = `Fertig. ${sentCount} Nachrichten gesendet, ${valid.length} Setups gefunden, ${candidates.length} Kandidaten geprüft (Quelle: CoinGecko).`;
  console.log(summary);
}

main().catch(async (err) => {
  console.error("Scan komplett fehlgeschlagen:", err);
  process.exit(1);
});
