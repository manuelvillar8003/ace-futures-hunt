import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// ================= GERMAN COMMENTS BY DESIGN — this mirrors the browser-side scanner logic =================
// Läuft serverseitig alle 5 Minuten, unabhängig von jedem offenen Browser-Tab.
// Bewusst schlanker als der volle 9-Faktoren-Coach im Browser (Zeitlimit 30s pro Ausführung):
// nutzt dieselbe 4-Faktoren-Logik wie der schnelle Scanner (Trend, Struktur, Smart Money, Funding).

const GRADE_RANK: Record<string, number> = { 'A+':6, 'A':5, 'B':4, 'C':3, 'D':2, 'F':1 };
const MEME_KEYWORDS = ['INU','MOON','ELON','DOGE','SHIB','PEPE','FLOKI','BABY','SAFEMOON','WOJAK','CHAD','1000','MINI'];

function memeScore(symbol: string){
  const base = symbol.replace('USDT','');
  let hits = 0;
  MEME_KEYWORDS.forEach(k => { if(base.includes(k)) hits++; });
  return Math.min(hits, 3);
}

function sma(values: number[], period: number){
  if(values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/period;
}

function analyzeTrend(closes: number[]){
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50);
  const last = closes[closes.length-1];
  if(sma20 === null || sma50 === null) return { label:'Nicht genug Daten', points:0 };
  if(last > sma20 && sma20 > sma50) return { label:'Aufwärtstrend', points:1 };
  if(last < sma20 && sma20 < sma50) return { label:'Abwärtstrend', points:-1 };
  return { label:'Seitwärts', points:0 };
}

function findPivots(highs: number[], lows: number[]){
  const swingHighs: {i:number, price:number}[] = [], swingLows: {i:number, price:number}[] = [];
  for(let i=3; i<highs.length-3; i++){
    if(highs[i] === Math.max(...highs.slice(i-3,i+4))) swingHighs.push({i, price:highs[i]});
    if(lows[i] === Math.min(...lows.slice(i-3,i+4))) swingLows.push({i, price:lows[i]});
  }
  return { swingHighs, swingLows };
}

function analyzeStructure(highs: number[], lows: number[]){
  const { swingHighs, swingLows } = findPivots(highs, lows);
  if(swingHighs.length < 2 || swingLows.length < 2){
    return { label:'Zu wenig Struktur', points:0, lastSwingHigh:Math.max(...highs.slice(-30)), lastSwingLow:Math.min(...lows.slice(-30)) };
  }
  const hh = swingHighs[swingHighs.length-1].price > swingHighs[swingHighs.length-2].price;
  const hl = swingLows[swingLows.length-1].price > swingLows[swingLows.length-2].price;
  const lh = swingHighs[swingHighs.length-1].price < swingHighs[swingHighs.length-2].price;
  const ll = swingLows[swingLows.length-1].price < swingLows[swingLows.length-2].price;
  let label, points;
  if(hh && hl){ label='Bullische Struktur'; points=1; }
  else if(lh && ll){ label='Bearische Struktur'; points=-1; }
  else { label='Range-Struktur'; points=0; }
  return { label, points, lastSwingHigh:swingHighs[swingHighs.length-1].price, lastSwingLow:swingLows[swingLows.length-1].price };
}

function analyzeSmartMoney(klines: any[]){
  let totalVol = 0, buyVol = 0;
  klines.slice(-48).forEach(k => { totalVol += parseFloat(k[5]); buyVol += parseFloat(k[9]); });
  const buyRatio = totalVol > 0 ? buyVol/totalVol : 0.5;
  let points = 0;
  if(buyRatio > 0.56) points = 1; else if(buyRatio < 0.44) points = -1;
  return { buyRatio, points };
}

function analyzeVolatility(highs: number[], lows: number[], closes: number[]){
  const trs: number[] = [];
  for(let i=1;i<closes.length;i++){
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const atr = sma(trs, 14) || (closes[closes.length-1]*0.01);
  return { atr };
}

function gradeFromScore(score: number, maxScore: number){
  const pct = Math.abs(score) / maxScore;
  if(pct >= 0.85) return 'A+';
  if(pct >= 0.72) return 'A';
  if(pct >= 0.6) return 'B';
  if(pct >= 0.48) return 'C';
  if(pct >= 0.38) return 'D';
  return 'F';
}

function composeReasonSentence(trendLabel: string, structureLabel: string, funding: number | undefined, bias: string){
  const parts: string[] = [];
  if(trendLabel.includes('Aufwärts')) parts.push('der Trend zeigt nach oben');
  else if(trendLabel.includes('Abwärts')) parts.push('der Trend zeigt nach unten');
  else parts.push('der Trend ist seitwärts');

  if(structureLabel.includes('Bullisch')) parts.push('die Preisstruktur macht Higher Highs/Higher Lows');
  else if(structureLabel.includes('Bearisch')) parts.push('die Preisstruktur macht Lower Highs/Lower Lows');

  if(funding !== undefined){
    if(funding > 0.02) parts.push('die Funding Rate ist positiv (Longs zahlen), was bei einer Short-Idee für zusätzlichen Druck sorgen könnte');
    else if(funding < -0.02) parts.push('die Funding Rate ist negativ (Shorts zahlen), was bei einer Long-Idee für zusätzlichen Squeeze-Druck sorgen könnte');
  }

  const dirWord = bias === 'LONG' ? 'für eine Long-Idee' : 'für eine Short-Idee';
  return `Zusammengefasst: ${parts.join(', ')} — das spricht ${dirWord}.`;
}

function fmtPrice(p: number){
  const n = p;
  if(n === 0 || isNaN(n)) return '0';
  if(n >= 1000) return n.toLocaleString('de-DE', {maximumFractionDigits:2});
  if(n >= 1) return n.toFixed(3);
  if(n >= 0.01) return n.toFixed(5);
  const magnitude = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.min(18, Math.max(6, -magnitude + 3));
  return n.toFixed(decimals);
}

async function sendTelegram(text: string){
  const token = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Netlify.env.get("TELEGRAM_CHAT_ID");
  if(!token || !chatId){
    console.error("TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt als Umgebungsvariable.");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if(!res.ok){
    console.error("Telegram-Fehler:", await res.text());
  }
}

export default async (req: Request) => {
  const store = getStore("ace-alerts");
  const minGrade = Netlify.env.get("MIN_GRADE") || "B";
  const minRank = GRADE_RANK[minGrade] ?? GRADE_RANK["A"];

  try{
    const [tickerRes, fundingRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/ticker/24hr'),
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex')
    ]);
    const tickerData = await tickerRes.json();
    const fundingData = await fundingRes.json();

    const fundingMap: Record<string, number> = {};
    fundingData.forEach((f: any) => { fundingMap[f.symbol] = parseFloat(f.lastFundingRate) * 100; });

    const stableQuotes = ['USDT'];
    const excludeBase = ['USDC','FDUSD','TUSD','DAI','USDP','EUR','TRY','BUSD','USD1'];
    const filtered = tickerData.filter((d: any) => {
      if(!d.symbol.endsWith('USDT')) return false;
      const base = d.symbol.slice(0,-4);
      if(excludeBase.includes(base)) return false;
      if(parseFloat(d.quoteVolume) < 100000) return false;
      return true;
    });

    const maxVol = Math.max(...filtered.map((d: any) => parseFloat(d.quoteVolume)));
    const candidates = filtered.map((d: any) => {
      const pct = Math.abs(parseFloat(d.priceChangePercent));
      const volScore = Math.log10(parseFloat(d.quoteVolume)+1) / Math.log10(maxVol+1);
      const funding = fundingMap[d.symbol];
      const fundingSignal = funding !== undefined ? Math.abs(funding) : 0;
      const quickScore = pct*0.6 + volScore*30 + fundingSignal*200;
      return { symbol: d.symbol, price: parseFloat(d.lastPrice), quickScore, volScore, meme: memeScore(d.symbol) };
    }).sort((a: any,b: any) => b.quickScore - a.quickScore).slice(0, 15);

    const results = await Promise.all(candidates.map(async (c: any) => {
      try{
        const klinesRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${c.symbol}&interval=1h&limit=150`);
        const klines = await klinesRes.json();
        const highs = klines.map((k: any) => parseFloat(k[2]));
        const lows = klines.map((k: any) => parseFloat(k[3]));
        const closes = klines.map((k: any) => parseFloat(k[4]));

        const trend = analyzeTrend(closes);
        const structure = analyzeStructure(highs, lows);
        const smartMoney = analyzeSmartMoney(klines);
        const volatility = analyzeVolatility(highs, lows, closes);
        const funding = fundingMap[c.symbol];

        let fundingPoints = 0;
        if(funding !== undefined){
          if(funding > 0.05) fundingPoints = -1;
          else if(funding > 0.02) fundingPoints = -0.5;
          else if(funding < -0.05) fundingPoints = 1;
          else if(funding < -0.02) fundingPoints = 0.5;
        }

        const totalScore = trend.points + structure.points + smartMoney.points + fundingPoints;
        const maxScore = 4;
        const grade = gradeFromScore(totalScore, maxScore);
        const bias = totalScore >= 1.2 ? 'LONG' : totalScore <= -1.2 ? 'SHORT' : 'NEUTRAL';

        const dir = bias === 'LONG' ? 1 : bias === 'SHORT' ? -1 : 0;
        const atr = volatility.atr;
        const entry = c.price;
        const stopRef = dir >= 0 ? Math.min(entry - atr, structure.lastSwingLow) : Math.max(entry + atr, structure.lastSwingHigh);
        const tp1 = dir >= 0 ? entry + 1.5*atr : entry - 1.5*atr;
        const tp2 = dir >= 0 ? entry + 3*atr : entry - 3*atr;
        const tp3 = dir >= 0 ? entry + 5*atr : entry - 5*atr;
        const stopDist = Math.abs(entry - stopRef) || 1;
        const rr1 = (Math.abs(tp1-entry)/stopDist).toFixed(2);
        const rr2 = (Math.abs(tp2-entry)/stopDist).toFixed(2);
        const rr3 = (Math.abs(tp3-entry)/stopDist).toFixed(2);

        const riskFlags = (volatility.atr/entry > 0.03 ? 1:0) + (c.volScore < 0.3 ? 1:0) + (c.meme>0 ? 1:0);
        const riskLevel = riskFlags >= 2 ? 'Hoch' : riskFlags === 1 ? 'Mittel' : 'Niedrig';

        return { symbol: c.symbol, price: entry, grade, bias, trend: trend.label, structure: structure.label,
          fundingLabel: funding !== undefined ? funding.toFixed(3)+'%' : 'k.A.', fundingRaw: funding, riskLevel,
          entry, stopRef, tp1, tp2, tp3, rr1, rr2, rr3 };
      } catch(err){
        return null;
      }
    }));

    const valid = results.filter((r: any) => r !== null && GRADE_RANK[r.grade] >= minRank && r.bias !== 'NEUTRAL');

    for(const r of valid as any[]){
      const key = `${r.symbol}|${r.grade}|${r.bias}`;
      const already = await store.get(key);
      if(already) continue; // schon in den letzten Stunden gemeldet

      const emoji = r.bias === 'LONG' ? '🚀' : '🔻';
      const reasonSentence = composeReasonSentence(r.trend, r.structure, r.fundingRaw, r.bias);
      const text = `${emoji} ${r.symbol.replace('USDT','')} ${r.bias} (Server-Scan, kein Tab nötig)\n\n` +
        `Note: ${r.grade} · Risiko: ${r.riskLevel}\n\n` +
        `${reasonSentence}\n\n` +
        `Referenz-Level (ATR/Struktur-basiert, keine Empfehlung):\n` +
        `Entry: ${fmtPrice(r.entry)}\nStop: ${fmtPrice(r.stopRef)}\n` +
        `TP1: ${fmtPrice(r.tp1)} (RR ${r.rr1})\nTP2: ${fmtPrice(r.tp2)} (RR ${r.rr2})\nTP3: ${fmtPrice(r.tp3)} (RR ${r.rr3})\n\n` +
        `Kein Finanzrat — eigene Prüfung + eigenes Risikomanagement nötig. ACE FUTURES HUNT`;

      await sendTelegram(text);
      await store.set(key, JSON.stringify({ at: Date.now() }));
    }

    console.log(`Scan fertig: ${valid.length} Setups über Schwelle ${minGrade}, ${candidates.length} Kandidaten geprüft.`);
  } catch(err: any){
    console.error("Scan-Fehler:", err.message);
  }
};

export const config: Config = {
  schedule: "*/5 * * * *"
};
