// Einfacher Verbindungstest: schickt eine Telegram-Nachricht, sonst nichts.
// Sobald bestaetigt, dass das ankommt, ersetzen wir das durch die echte Scan-Logik.

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

async function main() {
  console.log("Ping-Test startet...");
  console.log("Token gesetzt:", !!token, "| Chat-ID gesetzt:", !!chatId);

  if (!token || !chatId) {
    console.error("FEHLER: TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt als GitHub Secret.");
    process.exit(1);
  }

  const now = new Date().toISOString();
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ GitHub-Actions-Ping-Test von ACE FUTURES HUNT — ${now}`,
    }),
  });

  const body = await res.text();
  console.log("Telegram-Antwort Status:", res.status);
  console.log("Telegram-Antwort Body:", body);

  if (!res.ok) {
    console.error("Telegram hat den Versand abgelehnt.");
    process.exit(1);
  }

  console.log("Erfolgreich gesendet!");
}

main().catch((err) => {
  console.error("Unerwarteter Fehler:", err);
  process.exit(1);
});
