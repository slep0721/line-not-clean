import { config } from "./config.mjs";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const modelCooldownUntil = new Map();
let lastActiveModel = null;

const responseSchema = {
  type: "OBJECT",
  properties: {
    intent: {
      type: "STRING",
      enum: ["booking", "confirm", "select_plan", "cancel", "help", "inquiry", "other"],
      description: "使用者本則訊息的主要意圖",
    },
    date: {
      type: "STRING",
      description: "預約日期 YYYY-MM-DD；若本則訊息未提及或日期無效，請回傳空字串",
    },
    dateInvalid: {
      type: "BOOLEAN",
      description: "若使用者提供了不存在的日期（例如 2 月 30 日）則為 true，否則為 false",
    },
    time: {
      type: "STRING",
      description: "24 小時制預約時間 HH:MM；若本則訊息未提及、格式無效或無法判斷上午/下午，請回傳空字串",
    },
    timeAmbiguous: {
      type: "BOOLEAN",
      description: "若使用者只講 1~10 點且未明示早/中/午/晚，無法判斷是中午還是晚上則為 true",
    },
    timeInvalid: {
      type: "BOOLEAN",
      description: "若使用者提供了無效時間（例如 25:00 或 12:75）則為 true",
    },
    guestCount: {
      type: "INTEGER",
      description: "本則訊息提及的用餐總人數（含大人小孩合計，如四大一小為 5）；若未提及請回傳 0",
    },
    phone: {
      type: "STRING",
      description: "本則訊息提及的聯絡電話；若未提及請回傳空字串",
    },
    planChoice: {
      type: "STRING",
      enum: ["NONE", "A", "B"],
      description: "若目前正在等待選擇拆桌方案，且使用者表達選擇方案 A 或 B，請填入 A 或 B；否則填 NONE",
    },
    reply: {
      type: "STRING",
      description: "繁體中文自然回覆。intent 為 inquiry/help/other 時必填（180 字內）；若 intent 為 booking 但顧客同時詢問營業規則等問題，可填 1 句簡短回答，否則留空字串。嚴禁承諾有位或宣告訂位完成。",
    },
  },
  required: [
    "intent",
    "date",
    "dateInvalid",
    "time",
    "timeAmbiguous",
    "timeInvalid",
    "guestCount",
    "phone",
    "planChoice",
    "reply",
  ],
};

function buildCalendarReference(todayDate) {
  const weekdayFormatter = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "UTC",
    weekday: "short",
  });
  const base = new Date(`${todayDate}T12:00:00.000Z`);
  const lines = [];
  for (let offset = 0; offset < 14; offset += 1) {
    const current = new Date(base);
    current.setUTCDate(base.getUTCDate() + offset);
    const iso = current.toISOString().slice(0, 10);
    const weekday = weekdayFormatter.format(current);
    const alias = offset === 0 ? "（今天）" : offset === 1 ? "（明天）" : offset === 2 ? "（後天）" : "";
    lines.push(`${iso} ${weekday}${alias}`);
  }
  return lines.join("、");
}

function buildSystemInstruction({ todayDate, nowTime, restaurantInfo }) {
  const calendar = buildCalendarReference(todayDate);
  return [
    "你是台灣餐廳的 LINE 訂位語意理解助理，請將顧客訊息解析成嚴格符合 schema 的 JSON。",
    `目前台灣時間：${todayDate} ${nowTime}。`,
    `未來 14 天日期對照表（週一為一週開始）：${calendar}。`,
    "店家固定資訊（僅能根據以下事實回答，不可捏造菜單、價格、停車、包廂或寵物規定）：",
    restaurantInfo,
    "",
    "解析規則：",
    "1. 只抽取『本則訊息』新提供或要修改的欄位，不要重複抄寫草稿裡原本已有的舊欄位。",
    "2. 相對日期（如明天、後天、這週六、下週五、下禮拜三）請對照日期表轉成 YYYY-MM-DD。",
    "3. 時間轉成 24 小時制 HH:MM。例如「中午12點」「午餐12點半」-> 12:00 / 12:30；「晚上6點」「晚餐六點半」-> 18:00 / 18:30。",
    "   若顧客只講「6點」「7點半」且未明示早/中/晚/午餐/晚餐，請將 time 設為空字串並設 timeAmbiguous = true。",
    "4. 人數請加總大人小孩（如「四大一小」= 5，「一家三口」= 3，「我們兩個人」= 2）。切勿把『4人桌』『2小時』『6張桌』等店家規則數字誤當成 guestCount。",
    "5. 當系統正在等待確認（awaitingConfirmation = true）：",
    "   - 顧客同意訂位（如「好」「確認」「沒問題幫我訂」「OK」）-> intent = 'confirm'。",
    "   - 若有拆桌方案 A/B，顧客選第一個/A/對應桌型 -> intent = 'select_plan', planChoice = 'A'；選第二個/B/對應桌型 -> intent = 'select_plan', planChoice = 'B'；未選擇方案則 planChoice = 'NONE'。",
    "   - 若顧客要改日期、時間、人數或電話 -> intent = 'booking' 並填入欲修改的新欄位。",
    "6. 顧客放棄或取消流程（如「取消」「不訂了」「算了」）-> intent = 'cancel'。",
    "7. 顧客單純打招呼或詢問營業資訊 -> intent = 'inquiry' 或 'other'，並在 reply 用親切簡短的繁體中文回覆，同時引導提供訂位資訊。",
    "8. reply 絕不可承諾某時段有座位、不可自行計算桌位，也不可宣稱已完成訂位（這些由後端系統處理）。",
  ].join("\n");
}

function buildUserPayload({ message, draft, awaitingConfirmation, planDescriptions, recentMessages }) {
  const context = {
    awaitingConfirmation,
    currentDraft: {
      date: draft.date || null,
      time: draft.time || null,
      guestCount: draft.guestCount ?? null,
      phone: draft.phone || null,
    },
    availablePlanOptions: planDescriptions,
    recentConversation: recentMessages.slice(-6),
    latestCustomerMessage: message,
  };
  return JSON.stringify(context, null, 2);
}

function buildRequestBody(model, systemInstruction, userPayload) {
  const generationConfig = {
    responseMimeType: "application/json",
    responseSchema,
    maxOutputTokens: 512,
  };

  // Gemini 3.x non-lite Flash models default to medium thinking; low keeps latency fast for LINE replyToken.
  if (/^gemini-3/iu.test(model) && !/lite/iu.test(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: "low" };
  }

  return {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPayload }],
      },
    ],
    generationConfig,
  };
}

function extractTextFromResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => !part?.thought && typeof part?.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isModelUnavailableStatus(status) {
  return status === 404;
}

function selectModelOrder(models) {
  const now = Date.now();
  const ready = [];
  const cooling = [];

  for (const model of models) {
    const until = modelCooldownUntil.get(model) ?? 0;
    if (until <= now) {
      ready.push(model);
    } else {
      cooling.push({ model, until });
    }
  }

  if (ready.length > 0) return ready;

  // If every model is currently in cooldown, probe the one whose cooldown expires earliest once.
  cooling.sort((left, right) => left.until - right.until);
  return cooling.length > 0 ? [cooling[0].model] : [];
}

function markCooldown(model, multiplier = 1) {
  modelCooldownUntil.set(model, Date.now() + config.geminiCooldownMs * multiplier);
}

function sanitizeAnalysis(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const validIntents = new Set(["booking", "confirm", "select_plan", "cancel", "help", "inquiry", "other"]);
  const intent = validIntents.has(parsed.intent) ? parsed.intent : "other";
  const guestCount = Number.isInteger(parsed.guestCount) && parsed.guestCount > 0 ? parsed.guestCount : null;
  const planChoice = parsed.planChoice === "A" || parsed.planChoice === "B" ? parsed.planChoice : "";

  return {
    intent,
    date: typeof parsed.date === "string" ? parsed.date.trim() : "",
    dateInvalid: Boolean(parsed.dateInvalid),
    time: typeof parsed.time === "string" ? parsed.time.trim() : "",
    timeAmbiguous: Boolean(parsed.timeAmbiguous),
    timeInvalid: Boolean(parsed.timeInvalid),
    guestCount,
    phone: typeof parsed.phone === "string" ? parsed.phone.trim() : "",
    planChoice,
    reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
  };
}

async function callGeminiModel(model, body, timeoutMs) {
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`HTTP ${response.status} ${detail.slice(0, 220)}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const rawText = extractTextFromResponse(data);
  if (!rawText) throw new Error("EMPTY_RESPONSE");

  const cleaned = rawText.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const parsed = sanitizeAnalysis(JSON.parse(cleaned));
  if (!parsed) throw new Error("INVALID_JSON_PAYLOAD");
  return parsed;
}

export function isGeminiEnabled() {
  return Boolean(config.geminiApiKey && config.geminiModels.length > 0);
}

export function getGeminiStatus() {
  const now = Date.now();
  return {
    provider: "gemini",
    enabled: isGeminiEnabled(),
    models: config.geminiModels,
    lastActiveModel,
    cooldowns: Object.fromEntries(
      config.geminiModels
        .map((model) => [model, Math.max(0, Math.ceil(((modelCooldownUntil.get(model) ?? 0) - now) / 1000))])
        .filter(([, seconds]) => seconds > 0),
    ),
  };
}

export function resetGeminiStateForTests() {
  modelCooldownUntil.clear();
  lastActiveModel = null;
}

export async function analyzeReservationMessage({
  message,
  draft,
  awaitingConfirmation,
  planDescriptions,
  recentMessages,
  todayDate,
  nowTime,
  restaurantInfo,
}) {
  if (!isGeminiEnabled()) return null;

  const systemInstruction = buildSystemInstruction({ todayDate, nowTime, restaurantInfo });
  const userPayload = buildUserPayload({
    message,
    draft,
    awaitingConfirmation,
    planDescriptions,
    recentMessages,
  });

  const modelsToTry = selectModelOrder(config.geminiModels);
  const deadline = Date.now() + config.geminiTotalBudgetMs;

  for (const model of modelsToTry) {
    const remaining = deadline - Date.now();
    if (remaining < 1200) break;

    const timeoutMs = Math.min(config.geminiTimeoutMs, remaining);
    const body = buildRequestBody(model, systemInstruction, userPayload);

    try {
      const analysis = await callGeminiModel(model, body, timeoutMs);
      modelCooldownUntil.delete(model);
      lastActiveModel = model;
      return { model, analysis };
    } catch (error) {
      const status = error?.status ?? 0;
      if (status === 401 || status === 403) {
        console.error(`[gemini] API 金鑰驗證失敗（HTTP ${status}），暫停使用 Gemini 並降級為規則式問答。`);
        for (const candidate of config.geminiModels) markCooldown(candidate, 5);
        return null;
      }

      if (isModelUnavailableStatus(status)) {
        console.warn(`[gemini] 模型 ${model} 不可用（HTTP 404），已長時冷卻並切換備援模型。`);
        markCooldown(model, 10);
      } else if (isRetryableStatus(status) || error?.name === "TimeoutError" || error?.name === "AbortError") {
        console.warn(`[gemini] 模型 ${model} 過載或逾時（${error.message}），切換下一個備援模型。`);
        markCooldown(model, 1);
      } else {
        console.warn(`[gemini] 模型 ${model} 呼叫失敗（${error.message}），嘗試下一個備援模型。`);
      }
    }
  }

  console.warn("[gemini] 所有設定的 Gemini 模型暫時不可用，已自動降級為規則式問答。");
  return null;
}
