import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { config } from "./config.mjs";
import { handleMessage } from "./assistant.mjs";
import {
  claimWebhookEvent,
  completeWebhookEvent,
  database,
  getDashboardData,
  updateReservationStatus,
} from "./database.mjs";
import { getGeminiStatus } from "./gemini.mjs";
import { replyText, verifyLineSignature } from "./line.mjs";

const maxBodyBytes = 1024 * 1024;
const userQueues = new Map();
const eventClients = new Map();
const dashboardHtml = readFileSync(new URL("../admin.html", import.meta.url));
const testChatHtml = readFileSync(new URL("../test-chat.html", import.meta.url));
const browserStoreJs = readFileSync(new URL("../browser-store.js", import.meta.url));

function resolveAllowedOrigin(request) {
  const origin = String(request.headers.origin ?? "").trim().replace(/\/+$/u, "");
  if (!origin) return "";
  if (config.corsOrigins.includes(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/iu.test(origin)) return origin;
  if (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/iu.test(origin)) return origin;
  return "";
}

function corsHeaders(request) {
  const allowedOrigin = resolveAllowedOrigin(request);
  if (!allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}

function sendJson(request, response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(request),
  });
  response.end(JSON.stringify(body));
}

function isAuthorized(request) {
  const header = request.headers.authorization ?? "";
  const match = /^Basic\s+(.+)$/iu.exec(header);
  if (!match) return false;

  let credentials;
  try {
    credentials = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = credentials.indexOf(":");
  if (separator < 0 || credentials.slice(0, separator) !== "owner") return false;

  const supplied = Buffer.from(credentials.slice(separator + 1));
  const expected = Buffer.from(config.adminPassword);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requireAdmin(request, response) {
  if (isAuthorized(request)) return true;
  response.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Restaurant reservation dashboard", charset="UTF-8"',
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(request),
  });
  response.end(JSON.stringify({ error: "需要業主帳號登入。" }));
  return false;
}

function enqueueForUser(userId, task) {
  const previous = userQueues.get(userId) ?? Promise.resolve();
  let queued;
  queued = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (userQueues.get(userId) === queued) userQueues.delete(userId);
    });
  userQueues.set(userId, queued);
  return queued;
}

function broadcastEvent(eventName, payload) {
  const data = JSON.stringify(payload);
  for (const client of eventClients.keys()) {
    try {
      client.write(`event: ${eventName}\ndata: ${data}\n\n`);
    } catch {
      eventClients.delete(client);
    }
  }
}

function notifyReservationCreated(reservation) {
  broadcastEvent("reservation_created", {
    id: reservation.id,
    date: reservation.date,
    time: reservation.time,
    period: reservation.period,
    guestCount: reservation.guestCount,
    status: reservation.status,
  });
}

function notifyReservationUpdated(reservation) {
  broadcastEvent("reservation_updated", {
    id: reservation.id,
    date: reservation.date,
    time: reservation.time,
    period: reservation.period,
    guestCount: reservation.guestCount,
    status: reservation.status,
  });
}

async function processMessageEvent(event) {
  const eventId = event.webhookEventId;
  const userId = event.source?.userId;
  let responseText;

  try {
    if (!userId) throw new Error("這則 LINE 訊息沒有可用的使用者 ID。");
    if (event.message?.type !== "text") {
      responseText = "請用文字告訴我訂位日期、時間、人數和聯絡電話，我會協助您完成預約。";
    } else {
      const result = await handleMessage(userId, event.message.text ?? "");
      responseText = result.text;
      if (result.reservation) notifyReservationCreated(result.reservation);
    }
  } catch (error) {
    console.error("處理 LINE 訂位訊息時發生錯誤：", error.message);
    responseText = "我剛剛處理這則訊息時遇到問題，請稍後再傳一次。";
  }

  try {
    await replyText(event.replyToken, responseText);
    console.info("[line] 已回覆訂位訊息。");
  } catch (error) {
    console.error("[line] 無法回覆訂位訊息：", error.message);
  } finally {
    completeWebhookEvent(eventId);
  }
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const raw = await readRawBody(request);
  return JSON.parse(raw.toString("utf8"));
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function validPeriod(value) {
  return value === "lunch" || value === "dinner";
}

function openEventStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(request),
  });
  response.write("event: connected\ndata: {}\n\n");
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(": keep-alive\n\n");
  }, 20_000);
  eventClients.set(response, heartbeat);
  response.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(response);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, { ...corsHeaders(request), "Access-Control-Max-Age": "600" });
    response.end();
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(302, { Location: "/admin" });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(request, response, 200, {
      ok: true,
      service: "restaurant-reservations",
      timeZone: config.timeZone,
      ai: getGeminiStatus(),
    });
  }

  if (request.method === "GET" && url.pathname === "/browser-store.js") {
    response.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(browserStoreJs);
    return;
  }

  const protectedRoute = url.pathname === "/admin"
    || url.pathname === "/admin/"
    || url.pathname === "/admin.html"
    || url.pathname === "/test"
    || url.pathname === "/test/"
    || url.pathname === "/test-chat.html"
    || url.pathname.startsWith("/api/");
  if (protectedRoute && !requireAdmin(request, response)) return;

  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname === "/admin.html")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(dashboardHtml);
    return;
  }

  if (request.method === "GET" && (url.pathname === "/test" || url.pathname === "/test/" || url.pathname === "/test-chat.html")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(testChatHtml);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    openEventStream(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/reservations") {
    const date = url.searchParams.get("date") ?? "";
    const time = url.searchParams.get("time") ?? "";
    const period = url.searchParams.get("period") ?? "";
    const hasValidTime = time === "all" || validTime(time);
    const hasValidPeriod = validPeriod(period);

    if (!validDate(date) || (time && !hasValidTime) || (period && !hasValidPeriod) || (!time && !hasValidPeriod)) {
      return sendJson(request, response, 400, { error: "請提供有效日期、營業時段或時間。" });
    }
    return sendJson(request, response, 200, getDashboardData(date, time || "all", period));
  }

  const statusMatch = /^\/api\/reservations\/(\d+)\/status$/u.exec(url.pathname);
  if (request.method === "PATCH" && statusMatch) {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch {
      return sendJson(request, response, 400, { error: "無效的 JSON 內容。" });
    }

    const reservationId = Number(statusMatch[1]);
    const outcome = updateReservationStatus(reservationId, String(payload?.status ?? ""));
    if (outcome.error === "INVALID_STATUS") {
      return sendJson(request, response, 400, { error: "不支援的訂位狀態。" });
    }
    if (outcome.error === "NOT_FOUND") {
      return sendJson(request, response, 404, { error: "找不到這筆訂位資料。" });
    }
    if (outcome.error === "TABLE_CONFLICT") {
      return sendJson(request, response, 409, { error: "原桌位已被其他訂位使用，無法恢復成待入座或用餐中。" });
    }

    notifyReservationUpdated(outcome.reservation);
    return sendJson(request, response, 200, { reservation: outcome.reservation });
  }

  if (request.method === "POST" && url.pathname === "/api/test-chat") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch {
      return sendJson(request, response, 400, { error: "無效的 JSON 內容。" });
    }

    const rawUserId = String(payload?.userId ?? "local-tester-1").trim();
    const userId = `sim:${rawUserId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 40) || "default"}`;
    const message = String(payload?.message ?? "").trim();
    if (!message) {
      return sendJson(request, response, 400, { error: "請輸入要測試的訊息內容。" });
    }

    const startedAt = Date.now();
    try {
      const result = await enqueueForUser(userId, () => handleMessage(userId, message));
      if (result.reservation) notifyReservationCreated(result.reservation);
      return sendJson(request, response, 200, {
        text: result.text,
        reservation: result.reservation,
        meta: result.meta ?? { engine: "unknown", model: null },
        elapsedMs: Date.now() - startedAt,
        ai: getGeminiStatus(),
      });
    } catch (error) {
      console.error("[test-chat] 處理測試訊息失敗：", error.message);
      return sendJson(request, response, 500, { error: "處理測試訊息時發生錯誤。" });
    }
  }

  const isWebhookPath = url.pathname === "/webhook"
    || url.pathname === "/webhook/"
    || (url.pathname === "/" && Boolean(request.headers["x-line-signature"]));

  if (request.method === "POST" && isWebhookPath) {
    let rawBody;
    try {
      rawBody = await readRawBody(request);
    } catch (error) {
      const tooLarge = error.message === "BODY_TOO_LARGE";
      return sendJson(request, response, tooLarge ? 413 : 400, { error: tooLarge ? "Payload too large" : "Invalid request body" });
    }

    if (!verifyLineSignature(rawBody, request.headers["x-line-signature"])) {
      console.error("[webhook] LINE 簽章驗證失敗，請確認 LINE_CHANNEL_SECRET。");
      return sendJson(request, response, 401, { error: "Invalid LINE signature" });
    }

    let webhook;
    try {
      webhook = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return sendJson(request, response, 400, { error: "Invalid JSON" });
    }

    const events = Array.isArray(webhook.events) ? webhook.events : [];
    console.info(`[webhook] 驗證通過（路徑 ${url.pathname}，events: ${events.length}）。`);

    try {
      for (const event of events) {
        if (event.type !== "message" || !event.replyToken || !event.webhookEventId) continue;
        if (!claimWebhookEvent(event.webhookEventId)) continue;
        const userId = event.source?.userId ?? `event:${event.webhookEventId}`;
        void enqueueForUser(userId, () => processMessageEvent(event)).catch((error) => {
          console.error("背景處理 LINE 訂位訊息時發生錯誤：", error.message);
        });
      }
    } catch (error) {
      console.error("Webhook 記錄失敗：", error.message);
      return sendJson(request, response, 500, { error: "Unable to queue webhook events" });
    }

    return sendJson(request, response, 200, { ok: true });
  }

  console.warn(`[http] 404 Not Found: ${request.method} ${url.pathname}`);
  sendJson(request, response, 404, { error: "Not found" });
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`餐廳訂位服務已啟動：http://localhost:${config.port}`);
  console.log(`業主後台：http://localhost:${config.port}/admin（帳號 owner，密碼在 .env 的 ADMIN_PASSWORD）`);
  console.log(`對話測試模擬器：http://localhost:${config.port}/test（與後台同組帳密）`);
  const aiStatus = getGeminiStatus();
  if (aiStatus.enabled) {
    console.log(`AI 對話模式：Gemini 多模型備援（${aiStatus.models.join(" → ")} → 規則式兜底）`);
  } else {
    console.log("AI 對話模式：規則式問答（未設定 GEMINI_API_KEY）");
  }
});

function shutdown() {
  for (const [client, heartbeat] of eventClients) {
    clearInterval(heartbeat);
    client.end();
  }
  eventClients.clear();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
