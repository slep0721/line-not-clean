import { config } from "./config.mjs";
import {
  clearConversation,
  createReservation,
  getConversation,
  getTablePlans,
  saveConversation,
} from "./database.mjs";
import { analyzeReservationMessage, isGeminiEnabled } from "./gemini.mjs";

const numberWords = new Map([
  ["零", 0], ["〇", 0], ["一", 1], ["二", 2], ["兩", 2], ["两", 2], ["三", 3], ["四", 4],
  ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9], ["十", 10],
]);

const restaurantInfo = [
  "本店全年無休，營業時間分為中午時段 11:30–14:30、晚上時段 17:00–20:00。",
  "為保留 2 小時用餐時間，最晚入座時間為中午 12:30、晚上 18:00。",
  "店內有 6 張 4 人桌及 6 張 2 人桌，最多可接待 36 人。",
].join("\n");

function localDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function todayDate() {
  const parts = localDateParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function todayTime() {
  const parts = localDateParts();
  return `${parts.hour}:${parts.minute}`;
}

function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function validClockTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function dateWithoutYear(month, day, current) {
  const currentYear = Number(current.slice(0, 4));
  const thisYear = validDate(currentYear, month, day);
  if (!thisYear || thisYear >= current) return thisYear;
  return validDate(currentYear + 1, month, day);
}

function parseNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  if (!value) return null;
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, ones = ""] = value.split("十");
    const tensValue = !tens || tens === "十" ? 1 : numberWords.get(tens);
    const onesValue = ones ? numberWords.get(ones) : 0;
    if (tensValue === undefined || onesValue === undefined) return null;
    return tensValue * 10 + onesValue;
  }
  if (value.length === 1) return numberWords.get(value) ?? null;
  return null;
}

function parseDate(text) {
  const current = todayDate();
  if (/今天|今日/u.test(text)) return { value: current };
  if (/後天|后天/u.test(text)) return { value: shiftDate(current, 2) };
  if (/明天|明日/u.test(text)) return { value: shiftDate(current, 1) };

  let match = /(20\d{2})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*日?/u.exec(text);
  if (match) {
    const value = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return value ? { value } : { invalid: true };
  }

  const monthDay = /(?<!\d)(\d{1,2}|[零〇一二兩两三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[零〇一二兩两三四五六七八九十]{1,3})\s*日/u.exec(text);
  if (monthDay) {
    const month = parseNumber(monthDay[1]);
    const day = parseNumber(monthDay[2]);
    if (month === null || day === null) return { invalid: true };
    const value = dateWithoutYear(month, day, current);
    return value ? { value } : { invalid: true };
  }

  match = /(?<!\d)(\d{1,2})[/-](\d{1,2})(?!\d)/u.exec(text);
  if (match) {
    const value = dateWithoutYear(Number(match[1]), Number(match[2]), current);
    return value ? { value } : { invalid: true };
  }
  return null;
}

function parseClock(text) {
  const period = /(凌晨|早上|上午|中午|午餐|午間|下午|晚上|晚餐|晚間)/u.exec(text)?.[1] ?? "";
  const isEvening = ["下午", "晚上", "晚餐", "晚間"].includes(period);
  const isNoon = ["中午", "午餐", "午間"].includes(period);
  const isMorning = ["上午", "早上", "凌晨"].includes(period);

  const clock = /(?:凌晨|早上|上午|中午|午餐|午間|下午|晚上|晚餐|晚間)?\s*(\d{1,2})[:：](\d{2})/u.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return { invalid: true };
    if (isEvening && hour < 12) hour += 12;
    if (isNoon && hour < 11) hour += 12;
    if (isMorning && hour === 12) hour = 0;
    if (!period && hour >= 1 && hour <= 10) return { ambiguous: true };
    return { value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
  }

  const wordPattern = "零〇一二兩两三四五六七八九十";
  const time = new RegExp(`(?:凌晨|早上|上午|中午|午餐|午間|下午|晚上|晚餐|晚間)?\\s*(\\d{1,2}|[${wordPattern}]{1,3})\\s*(?:點|点|時|时)(?:\\s*(半|\\d{1,2}|[${wordPattern}]{1,3})\\s*分?)?`, "u").exec(text);
  if (!time) return null;

  let hour = parseNumber(time[1]);
  let minute = time[2] === "半" ? 30 : (time[2] ? parseNumber(time[2]) : 0);
  if (hour === null || minute === null || hour > 23 || minute > 59) return { invalid: true };
  if (isEvening && hour < 12) hour += 12;
  if (isNoon && hour < 11) hour += 12;
  if (isMorning && hour === 12) hour = 0;
  if (!period && hour >= 1 && hour <= 10) return { ambiguous: true };
  return { value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/gu, "");
  if (digits.startsWith("886")) digits = `0${digits.slice(3)}`;
  if (/^09\d{8}$/u.test(digits) || /^0[2-8]\d{7,9}$/u.test(digits)) return digits;
  return "";
}

function parsePhone(text) {
  const candidates = [];
  const labeled = /(?:電話|手機|聯絡電話|聯絡方式)\s*[:：]?\s*(\+?\d[\d ()-]{6,18}\d)/u.exec(text);
  if (labeled) candidates.push(labeled[1]);

  const patterns = [
    /(?<!\d)\+?886[- ]?9\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)/gu,
    /(?<!\d)09\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)/gu,
    /(?<!\d)0[2-8]\d?[- ]?\d{3,4}[- ]?\d{4}(?!\d)/gu,
  ];
  for (const pattern of patterns) candidates.push(...(text.match(pattern) ?? []));
  for (const candidate of candidates) {
    const phone = normalizePhone(candidate);
    if (phone) return phone;
  }
  return null;
}

function parsePartySize(text) {
  const match = /(?:共|總共|總計|人數)?\s*(\d{1,2}|[零〇一二兩两三四五六七八九十]{1,3})\s*(?:位|人|名|個人)/u.exec(text);
  return match ? parseNumber(match[1]) : null;
}

function parseUpdates(text) {
  return {
    date: parseDate(text),
    time: parseClock(text),
    guestCount: parsePartySize(text),
    phone: parsePhone(text),
  };
}

function hasAnyUpdate(updates) {
  return Boolean(
    updates.date?.value
    || updates.date?.invalid
    || updates.time?.value
    || updates.time?.invalid
    || updates.time?.ambiguous
    || (updates.guestCount !== null && updates.guestCount !== undefined)
    || updates.phone,
  );
}

function isWithinReservationHours(time) {
  const [hour, minute] = time.split(":").map(Number);
  const totalMinutes = hour * 60 + minute;
  return (totalMinutes >= 11 * 60 + 30 && totalMinutes <= 12 * 60 + 30)
    || (totalMinutes >= 17 * 60 && totalMinutes <= 18 * 60);
}

function dateLabel(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: config.timeZone,
    dateStyle: "full",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function planLabel(plan) {
  const parts = [];
  if (plan.fourTables) parts.push(`${plan.fourTables} 張 4 人桌`);
  if (plan.twoTables) parts.push(`${plan.twoTables} 張 2 人桌`);
  return `${parts.join(" + ")}（共 ${plan.capacity} 個座位）`;
}

function reservationSummary(draft, plan) {
  return [
    `日期：${dateLabel(draft.date)}`,
    `時間：${draft.time}`,
    `人數：${draft.guestCount} 位`,
    `電話：${draft.phone}`,
    plan ? `座位：${planLabel(plan)}` : "",
  ].filter(Boolean).join("\n");
}

function appendHistory(draft, userText, assistantText) {
  const history = Array.isArray(draft.recentMessages) ? draft.recentMessages.slice(-4) : [];
  history.push({ role: "user", text: userText.slice(0, 240) });
  history.push({ role: "assistant", text: assistantText.slice(0, 320) });
  return { ...draft, recentMessages: history.slice(-6) };
}

function saveDraft(userId, draft, userText, response, awaitingConfirmation = false) {
  const nextDraft = appendHistory(draft, userText, response);
  saveConversation(userId, {
    draft: nextDraft,
    awaitingConfirmation,
    lastAssistantMessage: response,
  });
  return { text: response, reservation: null };
}

function finishReservation(userId, draft, plan, userText) {
  const reservation = createReservation(draft, plan);
  if (!reservation) {
    const response = "不好意思，這個時段的座位剛被訂走了。請提供其他營業時間內的日期與時間。";
    return saveDraft(userId, { ...draft, planOptions: [] }, userText, response);
  }

  clearConversation(userId);
  return {
    text: `訂位完成，訂位編號 #${reservation.id}\n${reservationSummary(draft, plan)}\n\n每桌用餐時間為 2 小時，期待您的光臨！`,
    reservation,
  };
}

function helpText() {
  return [
    "您好，這裡是餐廳訂位助理。請告訴我訂位日期、時間、人數和聯絡電話；缺少的資料我會逐項詢問。",
    "範例：明天晚上 6 點，5 位，電話 0912345678。",
    "大於 4 位會先提供可用的拆桌方案，您選擇後才完成訂位。輸入「取消」可放棄目前訂位。",
    restaurantInfo,
  ].join("\n\n");
}

function confirmationPrompt(draft, plans) {
  const summary = reservationSummary(draft);
  if (draft.guestCount <= 4) {
    return `${summary}\n\n回覆「確認」完成訂位；如需修改，直接傳送正確資料。`;
  }

  const options = plans.map((plan, index) => `${String.fromCharCode(65 + index)}：${planLabel(plan)}`);
  return [
    `${summary}\n\n${draft.guestCount} 位需分桌安排，請選擇方案：`,
    ...options,
    plans.length > 1 ? "請回覆 A 或 B 完成訂位，或輸入「取消」。" : "請回覆 A 完成訂位，或輸入「取消」。",
  ].join("\n");
}

function findPlanChoice(text, plans) {
  const match = /^(?:方案\s*)?([AB])\s*[。.!]?$/iu.exec(text.trim());
  if (match) {
    const index = match[1].toUpperCase().charCodeAt(0) - 65;
    return plans[index] ?? null;
  }
  if (plans.length === 1 && /^(接受|確認|好|可以|是|ok|yes)$/iu.test(text.trim())) return plans[0];
  return null;
}

function confirmWords(text) {
  return /^(確認|好|可以|是|正確|沒錯|ok|yes)$/iu.test(text.trim());
}

function cancelWords(text) {
  return /^(取消|不要|放棄|no|cancel)$/iu.test(text.trim());
}

function emptyDraft(previous = {}) {
  return {
    date: previous.date ?? "",
    time: previous.time ?? "",
    guestCount: previous.guestCount ?? null,
    phone: previous.phone ?? "",
    planOptions: Array.isArray(previous.planOptions) ? previous.planOptions : [],
    recentMessages: Array.isArray(previous.recentMessages) ? previous.recentMessages : [],
  };
}

function applyUpdates(draft, updates) {
  const next = { ...draft, planOptions: [] };
  if (updates.date?.value) next.date = updates.date.value;
  if (updates.time?.value) next.time = updates.time.value;
  if (updates.guestCount !== null && updates.guestCount !== undefined) next.guestCount = updates.guestCount;
  if (updates.phone) next.phone = updates.phone;
  return next;
}

function prependNote(prefix, body) {
  return prefix ? `${prefix}\n\n${body}` : body;
}

function recordedSummaryLine(draft) {
  const items = [];
  if (draft.date) items.push(`日期 ${draft.date}`);
  if (draft.time) items.push(`時間 ${draft.time}`);
  if (draft.guestCount) items.push(`${draft.guestCount} 位`);
  if (draft.phone) items.push(`電話 ${draft.phone}`);
  return items.length > 0 ? `目前已記錄：${items.join("、")}。` : "";
}

function askForDetails(userId, draft, updates, userText, prefixNote = "") {
  if (updates.date?.invalid) {
    return saveDraft(
      userId,
      draft,
      userText,
      prependNote(prefixNote, "日期格式或日期不存在，請重新提供，例如 2026/12/24。時間若已確定也可一起告訴我。"),
    );
  }
  if (updates.time?.invalid) {
    return saveDraft(
      userId,
      draft,
      userText,
      prependNote(prefixNote, "時間格式不正確，請用 24 小時制，例如 12:00 或 18:00。"),
    );
  }
  if (updates.time?.ambiguous) {
    return saveDraft(
      userId,
      draft,
      userText,
      prependNote(prefixNote, "請說明中午或晚上，或直接使用 24 小時制，例如 12:00、18:00。"),
    );
  }
  if (updates.phoneInvalid) {
    return saveDraft(
      userId,
      draft,
      userText,
      prependNote(prefixNote, "聯絡電話格式似乎不完整，請提供台灣手機或市話號碼，例如 0912345678 或 02-12345678。"),
    );
  }

  const progress = recordedSummaryLine(draft);
  const withProgress = (prompt) => prependNote(prefixNote, progress ? `${progress}\n${prompt}` : prompt);

  if (!draft.date) return saveDraft(userId, draft, userText, withProgress("請問想預約哪一天？可回覆「明天」、「這週六」或「12 月 24 日」。"));
  if (draft.date < todayDate()) {
    return saveDraft(userId, { ...draft, date: "" }, userText, prependNote(prefixNote, "請提供今天或之後的日期。"));
  }
  if (!draft.time) return saveDraft(userId, draft, userText, withProgress("請問想預約幾點？可輸入中午 11:30–12:30 或晚上 17:00–18:00。"));
  if (draft.date === todayDate() && draft.time <= todayTime()) {
    return saveDraft(userId, { ...draft, time: "" }, userText, prependNote(prefixNote, "這個時間已經過了，請提供今天稍晚或其他日期的時間。"));
  }
  if (!isWithinReservationHours(draft.time)) {
    return saveDraft(
      userId,
      { ...draft, time: "" },
      userText,
      prependNote(prefixNote, `您提供的時間不在可訂位時段內。\n${restaurantInfo}\n\n請重新提供日期與時間。`),
    );
  }
  if (!draft.guestCount) return saveDraft(userId, draft, userText, withProgress("請問一共有幾位用餐？"));
  if (draft.guestCount > 36) {
    return saveDraft(
      userId,
      { ...draft, guestCount: null },
      userText,
      prependNote(prefixNote, `本店最多可安排 36 位，${restaurantInfo}\n\n請重新提供人數。`),
    );
  }
  if (!draft.phone) return saveDraft(userId, draft, userText, withProgress("請提供聯絡電話，例如 0912345678 或 02-12345678。"));

  const plans = getTablePlans(draft.date, draft.time, draft.guestCount);
  if (plans.length === 0) {
    return saveDraft(userId, draft, userText, prependNote(prefixNote, `抱歉，這個時段沒有合適的座位，請換一個時間。\n${restaurantInfo}`));
  }

  const response = prependNote(prefixNote, confirmationPrompt(draft, plans));
  return saveDraft(userId, { ...draft, planOptions: plans }, userText, response, true);
}

function updatesFromGemini(analysis) {
  let date = null;
  if (analysis.dateInvalid) {
    date = { invalid: true };
  } else if (analysis.date) {
    const valid = validIsoDate(analysis.date);
    date = valid ? { value: valid } : { invalid: true };
  }

  let time = null;
  if (analysis.timeInvalid) {
    time = { invalid: true };
  } else if (analysis.timeAmbiguous) {
    time = { ambiguous: true };
  } else if (analysis.time) {
    const valid = validClockTime(analysis.time);
    time = valid ? { value: valid } : { invalid: true };
  }

  let phone = null;
  let phoneInvalid = false;
  if (analysis.phone) {
    const normalized = normalizePhone(analysis.phone);
    if (normalized) {
      phone = normalized;
    } else {
      phoneInvalid = true;
    }
  }

  return {
    date,
    time,
    guestCount: analysis.guestCount,
    phone,
    phoneInvalid,
  };
}

function handleWithRules(userId, text, conversation, draft) {
  if (conversation.awaitingConfirmation) {
    if (draft.guestCount > 4) {
      const selectedPlan = findPlanChoice(text, draft.planOptions ?? []);
      if (selectedPlan) return finishReservation(userId, draft, selectedPlan, text);
      if (!hasAnyUpdate(parseUpdates(text))) {
        return { text: confirmationPrompt(draft, draft.planOptions ?? []), reservation: null };
      }
    } else {
      if (confirmWords(text)) return finishReservation(userId, draft, draft.planOptions?.[0], text);
      if (!hasAnyUpdate(parseUpdates(text))) {
        return { text: confirmationPrompt(draft, draft.planOptions ?? []), reservation: null };
      }
    }
  }

  const updates = parseUpdates(text);
  const nextDraft = applyUpdates(draft, updates);
  return askForDetails(userId, nextDraft, updates, text);
}

export async function handleMessage(userId, message) {
  const text = message.trim();
  const command = text.toLocaleLowerCase("en-US");
  const withMeta = (result, engine, model = null) => ({ ...result, meta: { engine, model } });

  // Fast deterministic paths save Gemini quota and keep exact commands instant.
  if (command === "/help" || text === "幫助" || text === "訂位說明") {
    return withMeta({ text: helpText(), reservation: null }, "fast-path");
  }
  if (command === "/cancel" || cancelWords(text)) {
    clearConversation(userId);
    return withMeta(
      { text: "已取消目前的訂位流程。若要重新預約，請告訴我日期、時間、人數和電話。", reservation: null },
      "fast-path",
    );
  }
  if (command === "/new") clearConversation(userId);

  const conversation = getConversation(userId);
  let draft = emptyDraft(conversation.draft ?? {});

  // Fast path for unambiguous confirmations / plan codes when already waiting for confirmation.
  if (conversation.awaitingConfirmation) {
    if (draft.guestCount > 4) {
      const selectedPlan = findPlanChoice(text, draft.planOptions ?? []);
      if (selectedPlan) return withMeta(finishReservation(userId, draft, selectedPlan, text), "fast-path");
    } else if (confirmWords(text)) {
      return withMeta(finishReservation(userId, draft, draft.planOptions?.[0], text), "fast-path");
    }
  }

  if (isGeminiEnabled()) {
    const planDescriptions = (draft.planOptions ?? []).map(
      (plan, index) => `${String.fromCharCode(65 + index)}：${planLabel(plan)}`,
    );
    const geminiResult = await analyzeReservationMessage({
      message: text,
      draft,
      awaitingConfirmation: conversation.awaitingConfirmation,
      planDescriptions,
      recentMessages: draft.recentMessages,
      todayDate: todayDate(),
      nowTime: todayTime(),
      restaurantInfo,
    });

    if (geminiResult) {
      const { model, analysis } = geminiResult;

      if (analysis.intent === "cancel") {
        clearConversation(userId);
        return withMeta(
          {
            text: analysis.reply || "已取消目前的訂位流程。若要重新預約，請告訴我日期、時間、人數和電話。",
            reservation: null,
          },
          "gemini",
          model,
        );
      }

      if (analysis.intent === "help") {
        return withMeta(
          { text: analysis.reply ? `${analysis.reply}\n\n${restaurantInfo}` : helpText(), reservation: null },
          "gemini",
          model,
        );
      }

      if (conversation.awaitingConfirmation) {
        if (analysis.intent === "select_plan" && draft.guestCount > 4) {
          const index = analysis.planChoice ? analysis.planChoice.charCodeAt(0) - 65 : -1;
          const selectedPlan = index >= 0 ? draft.planOptions[index] : null;
          if (selectedPlan) return withMeta(finishReservation(userId, draft, selectedPlan, text), "gemini", model);
        }
        if (analysis.intent === "confirm") {
          if (draft.guestCount <= 4) {
            return withMeta(finishReservation(userId, draft, draft.planOptions[0], text), "gemini", model);
          }
          if (draft.planOptions.length === 1) {
            return withMeta(finishReservation(userId, draft, draft.planOptions[0], text), "gemini", model);
          }
        }
      }

      const updates = updatesFromGemini(analysis);
      if (hasAnyUpdate(updates) || updates.phoneInvalid) {
        draft = applyUpdates(draft, updates);
        return withMeta(askForDetails(userId, draft, updates, text, analysis.reply), "gemini", model);
      }

      if (analysis.intent === "inquiry" || analysis.intent === "other") {
        const baseReply = analysis.reply || "您好，如需訂位，請告訴我預約日期、時間、人數與聯絡電話。";
        if (conversation.awaitingConfirmation) {
          const reply = `${baseReply}\n\n您目前有一筆待確認的訂位：\n${confirmationPrompt(draft, draft.planOptions)}`;
          return withMeta(saveDraft(userId, draft, text, reply, true), "gemini", model);
        }
        return withMeta(saveDraft(userId, draft, text, baseReply, false), "gemini", model);
      }

      if (conversation.awaitingConfirmation) {
        return withMeta({ text: confirmationPrompt(draft, draft.planOptions), reservation: null }, "gemini", model);
      }

      return withMeta(askForDetails(userId, draft, updates, text, analysis.reply), "gemini", model);
    }
  }

  // Graceful fallback to rule-based parser when Gemini is disabled or all models are overloaded.
  return withMeta(handleWithRules(userId, text, conversation, draft), "rules");
}
