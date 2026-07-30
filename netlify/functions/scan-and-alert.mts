import type { Config } from "@netlify/functions";

// TEMPORAER radikal vereinfacht zum Debuggen. Wichtig: process.env statt Netlify.env.get,
// da letzteres in diesem Kontext evtl. nicht existiert (Ursache fuer bisheriges Totalversagen).
export default async (req: Request) => {
  try{
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if(!token || !chatId){
      const msg = `FEHLT: token=${!!token}, chatId=${!!chatId}`;
      console.log(msg);
      return new Response(msg, { status: 200 });
    }

    const now = new Date().toISOString();
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `✅ Ping-Test v2 von ACE FUTURES HUNT — ${now}` })
    });
    const body = await res.text();
    console.log(`Telegram-Antwort (Status ${res.status}):`, body);
    return new Response(`sent, telegram status ${res.status}: ${body}`, { status: 200 });
  } catch(err: any){
    console.log("Ping komplett fehlgeschlagen:", err?.message || String(err));
    return new Response(`error: ${err?.message || String(err)}`, { status: 200 });
  }
};

export const config: Config = {
  schedule: "*/5 * * * *"
};
