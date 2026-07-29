import type { Config } from "@netlify/functions";

// TEMPORAER radikal vereinfacht zum Debuggen: nur ein Ping, keine Analyse-Logik,
// keine Blobs. Wenn das ankommt, bauen wir die echte Logik schrittweise wieder ein.
export default async (req: Request) => {
  const token = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Netlify.env.get("TELEGRAM_CHAT_ID");

  if(!token || !chatId){
    console.log("FEHLT: TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID nicht gesetzt.");
    return new Response("missing env vars", { status: 200 });
  }

  const now = new Date().toISOString();
  try{
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `✅ Ping-Test von ACE FUTURES HUNT — ${now}` })
    });
    const body = await res.text();
    console.log(`Telegram-Antwort (Status ${res.status}):`, body);
  } catch(err: any){
    console.log("Ping fehlgeschlagen:", err.message);
  }

  return new Response("ok", { status: 200 });
};

export const config: Config = {
  schedule: "*/5 * * * *"
};
