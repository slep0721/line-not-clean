import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";

export function verifyLineSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = createHmac("sha256", config.lineChannelSecret).update(rawBody).digest();
  let received;
  try {
    received = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function replyText(replyToken, text) {
  const boundedText = text.length > 4900 ? `${text.slice(0, 4890)}……` : text;
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.lineChannelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: boundedText }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LINE 回覆失敗：HTTP ${response.status} ${detail}`);
  }
}
