(() => {
  const URL_KEY = "restaurant_backend_url";
  const PASS_KEY = "restaurant_backend_pass";
  const STORE_KEY = "restaurant_ghpages_reservations_v1";
  const INIT_KEY = "restaurant_ghpages_initialized_v1";
  const DRAFTS_KEY = "restaurant_ghpages_drafts_v1";
  const EVENT_KEY = "restaurant_ghpages_last_event_v1";

  const SERVICE_PERIODS = {
    lunch: {
      id: "lunch",
      label: "中午時段",
      open: "11:30",
      close: "14:30",
      lastSeating: "12:30",
      startMinutes: 11 * 60 + 30,
      endMinutes: 14 * 60 + 30,
      slots: ["11:30", "12:00", "12:30", "13:00", "13:30", "14:00"],
    },
    dinner: {
      id: "dinner",
      label: "晚上時段",
      open: "17:00",
      close: "20:00",
      lastSeating: "18:00",
      startMinutes: 17 * 60,
      endMinutes: 20 * 60,
      slots: ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30"],
    },
  };

  const RESERVATION_STATUSES = ["reserved", "seated", "completed", "cancelled"];
  const TABLE_INVENTORY = [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `4-${index + 1}`, capacity: 4 })),
    ...Array.from({ length: 6 }, (_, index) => ({ id: `2-${index + 1}`, capacity: 2 })),
  ];

  const NUMBER_WORDS = new Map([
    ["零", 0], ["〇", 0], ["一", 1], ["二", 2], ["兩", 2], ["两", 2], ["三", 3], ["四", 4],
    ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9], ["十", 10],
  ]);

  const RESTAURANT_INFO = [
    "本店全年無休，營業時間分為中午時段 11:30–14:30、晚上時段 17:00–20:00。",
    "為保留 2 小時用餐時間，最晚入座時間為中午 12:30、晚上 18:00。",
    "店內有 6 張 4 人桌及 6 張 2 人桌，最多可接待 36 人。",
  ].join("\n");

  function localToday() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function localNowTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  function minutesFromTime(value) {
    const match = /^(\d{2}):(\d{2})$/u.exec(value || "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  }

  function addMinutesToTime(value, delta) {
    const mins = minutesFromTime(value);
    if (Number.isNaN(mins)) return "";
    const total = (mins + delta) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  function formatLocalClock(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) return "";
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function getServicePeriod(time) {
    const mins = minutesFromTime(time);
    if (Number.isNaN(mins)) return "lunch";
    return mins < 15 * 60 ? "lunch" : "dinner";
  }

  function isBlockingStatus(status) {
    return status === "reserved" || status === "seated";
  }

  function conflictsWithReservation(reservation, candidateTime) {
    const existingStart = minutesFromTime(reservation.time);
    const candidateStart = minutesFromTime(candidateTime);
    if (Number.isNaN(existingStart) || Number.isNaN(candidateStart)) return false;
    return Math.abs(existingStart - candidateStart) < 120;
  }

  function isOccupiedAt(reservation, selectedTime) {
    const start = minutesFromTime(reservation.time);
    const selected = minutesFromTime(selectedTime);
    if (Number.isNaN(start) || Number.isNaN(selected)) return false;
    return start <= selected && selected < start + 120;
  }

  function overlapsPeriod(reservation, periodConfig) {
    const start = minutesFromTime(reservation.time);
    if (Number.isNaN(start)) return false;
    return start < periodConfig.endMinutes && periodConfig.startMinutes < start + 120;
  }

  function normalizeReservation(raw) {
    const status = RESERVATION_STATUSES.includes(raw.status) ? raw.status : "reserved";
    const seatedTime = formatLocalClock(raw.seatedAt);
    const endTime = addMinutesToTime(raw.time, 120);
    const expectedEndTime = status === "seated" && seatedTime
      ? addMinutesToTime(seatedTime, 120)
      : endTime;
    return {
      id: Number(raw.id),
      date: raw.date,
      time: raw.time,
      endTime,
      expectedEndTime,
      period: getServicePeriod(raw.time),
      guestCount: Number(raw.guestCount),
      phone: raw.phone,
      tables: Array.isArray(raw.tables) ? raw.tables : [],
      status,
      seatedAt: raw.seatedAt ?? null,
      seatedTime,
      completedAt: raw.completedAt ?? null,
      createdAt: raw.createdAt || new Date().toISOString(),
    };
  }

  function readAllLocalReservations() {
    if (!localStorage.getItem(INIT_KEY)) {
      seedDemoData();
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.map(normalizeReservation) : [];
    } catch {
      return [];
    }
  }

  function writeAllLocalReservations(list, eventInfo = null) {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    localStorage.setItem(INIT_KEY, "1");
    if (eventInfo) {
      localStorage.setItem(EVENT_KEY, JSON.stringify({ ...eventInfo, at: Date.now() }));
      window.dispatchEvent(new CustomEvent("restaurant-local-change", { detail: eventInfo }));
    }
  }

  function seedDemoData() {
    const today = localToday();
    const nowIso = new Date().toISOString();
    const demo = [
      {
        id: 1,
        date: today,
        time: "12:00",
        guestCount: 4,
        phone: "0912345678",
        tables: ["4-1"],
        status: "reserved",
        seatedAt: null,
        completedAt: null,
        createdAt: nowIso,
      },
      {
        id: 2,
        date: today,
        time: "18:00",
        guestCount: 5,
        phone: "0987654321",
        tables: ["4-1", "2-1"],
        status: "reserved",
        seatedAt: null,
        completedAt: null,
        createdAt: nowIso,
      },
    ];
    writeAllLocalReservations(demo, { type: "reservation_updated" });
  }

  function clearLocalData() {
    localStorage.removeItem(DRAFTS_KEY);
    writeAllLocalReservations([], { type: "reservation_updated" });
  }

  function availableLocalInventory(date, time, excludeId = null) {
    const busy = new Set(
      readAllLocalReservations()
        .filter((item) => item.date === date && item.id !== excludeId)
        .filter((item) => isBlockingStatus(item.status))
        .filter((item) => conflictsWithReservation(item, time))
        .flatMap((item) => item.tables),
    );
    return TABLE_INVENTORY.filter((table) => !busy.has(table.id));
  }

  function enumeratePlans(availableTables, guestCount) {
    const availableFour = availableTables.filter((t) => t.capacity === 4).length;
    const availableTwo = availableTables.filter((t) => t.capacity === 2).length;
    const plans = [];

    for (let fourTables = 0; fourTables <= availableFour; fourTables += 1) {
      for (let twoTables = 0; twoTables <= availableTwo; twoTables += 1) {
        const tableCount = fourTables + twoTables;
        const capacity = fourTables * 4 + twoTables * 2;
        if (capacity < guestCount || tableCount === 0) continue;
        if (guestCount <= 2 && tableCount !== 1) continue;
        if (guestCount >= 3 && guestCount <= 4 && (tableCount !== 1 || fourTables !== 1)) continue;
        if (guestCount > 4 && tableCount < 2) continue;
        plans.push({ fourTables, twoTables, tableCount, capacity });
      }
    }

    plans.sort((a, b) =>
      a.tableCount - b.tableCount
      || (a.capacity - guestCount) - (b.capacity - guestCount)
      || b.fourTables - a.fourTables,
    );

    if (plans.length === 0) return [];
    const fewest = plans[0].tableCount;
    return plans.filter((p) => p.tableCount === fewest).slice(0, 2);
  }

  function summarizeReservations(list) {
    const reserved = list.filter((i) => i.status === "reserved");
    const seated = list.filter((i) => i.status === "seated");
    const completed = list.filter((i) => i.status === "completed");
    const cancelled = list.filter((i) => i.status === "cancelled");
    const active = [...reserved, ...seated];
    const effective = [...active, ...completed];
    const sumGuests = (items) => items.reduce((sum, item) => sum + item.guestCount, 0);

    return {
      effectiveGroups: effective.length,
      effectiveGuests: sumGuests(effective),
      activeGroups: active.length,
      activeGuests: sumGuests(active),
      reservedGroups: reserved.length,
      reservedGuests: sumGuests(reserved),
      seatedGroups: seated.length,
      seatedGuests: sumGuests(seated),
      completedGroups: completed.length,
      completedGuests: sumGuests(completed),
      cancelledGroups: cancelled.length,
      cancelledGuests: sumGuests(cancelled),
    };
  }

  function getLocalDashboardData(date, time = "all", requestedPeriod = "") {
    const resolvedPeriod = requestedPeriod === "lunch" || requestedPeriod === "dinner"
      ? requestedPeriod
      : (time && time !== "all" ? getServicePeriod(time) : "lunch");
    const periodConfig = SERVICE_PERIODS[resolvedPeriod];
    const resolvedTime = time && time !== "all" ? time : "all";

    const reservations = readAllLocalReservations()
      .filter((item) => item.date === date)
      .sort((a, b) => a.time.localeCompare(b.time) || a.id - b.id);

    const occupying = reservations
      .filter((item) => isBlockingStatus(item.status))
      .filter((item) => (resolvedTime === "all" ? overlapsPeriod(item, periodConfig) : isOccupiedAt(item, resolvedTime)));

    const occupancyMap = new Map();
    for (const item of occupying) {
      for (const tableId of item.tables) {
        const current = occupancyMap.get(tableId);
        if (!current || (current.status !== "seated" && item.status === "seated")) {
          occupancyMap.set(tableId, item);
        }
      }
    }

    const tables = TABLE_INVENTORY.map((table) => {
      const active = occupancyMap.get(table.id) ?? null;
      const state = active ? active.status : "available";
      return {
        ...table,
        state,
        reserved: state !== "available",
        reservation: active
          ? {
              id: active.id,
              time: active.time,
              endTime: active.endTime,
              expectedEndTime: active.expectedEndTime,
              guestCount: active.guestCount,
              phone: active.phone,
              status: active.status,
              seatedTime: active.seatedTime,
              tables: active.tables,
            }
          : null,
      };
    });

    const lunchReservations = reservations.filter((item) => item.period === "lunch");
    const dinnerReservations = reservations.filter((item) => item.period === "dinner");
    const periodReservations = resolvedPeriod === "lunch" ? lunchReservations : dinnerReservations;
    const nextUpcoming = periodReservations.find((item) => item.status === "reserved")
      ?? reservations.find((item) => item.status === "reserved")
      ?? null;

    const availableTables = tables.filter((t) => t.state === "available");
    const reservedTables = tables.filter((t) => t.state === "reserved");
    const seatedTables = tables.filter((t) => t.state === "seated");

    return {
      date,
      period: resolvedPeriod,
      time: resolvedTime,
      reservations,
      periods: {
        lunch: { ...SERVICE_PERIODS.lunch, reservations: lunchReservations, summary: summarizeReservations(lunchReservations) },
        dinner: { ...SERVICE_PERIODS.dinner, reservations: dinnerReservations, summary: summarizeReservations(dinnerReservations) },
      },
      summary: {
        day: summarizeReservations(reservations),
        period: summarizeReservations(periodReservations),
        tables: {
          totalTables: tables.length,
          availableTables: availableTables.length,
          reservedTables: reservedTables.length,
          seatedTables: seatedTables.length,
          occupiedTables: reservedTables.length + seatedTables.length,
          availableSeats: availableTables.reduce((sum, t) => sum + t.capacity, 0),
          totalSeats: tables.reduce((sum, t) => sum + t.capacity, 0),
        },
        nextUpcoming,
      },
      tables,
    };
  }

  function updateLocalReservationStatus(id, nextStatus) {
    if (!RESERVATION_STATUSES.includes(nextStatus)) {
      throw new Error("不支援的訂位狀態。");
    }
    const list = readAllLocalReservations();
    const index = list.findIndex((item) => item.id === Number(id));
    if (index < 0) throw new Error("找不到這筆訂位資料。");

    const existing = list[index];
    if (!isBlockingStatus(existing.status) && isBlockingStatus(nextStatus)) {
      const freeIds = new Set(availableLocalInventory(existing.date, existing.time, existing.id).map((t) => t.id));
      if (!existing.tables.every((tableId) => freeIds.has(tableId))) {
        throw new Error("原桌位已被其他訂位使用，無法恢復成待入座或用餐中。");
      }
    }

    const nowIso = new Date().toISOString();
    let seatedAt = existing.seatedAt;
    let completedAt = existing.completedAt;
    if (nextStatus === "reserved") {
      seatedAt = null;
      completedAt = null;
    } else if (nextStatus === "seated") {
      seatedAt = seatedAt || nowIso;
      completedAt = null;
    } else if (nextStatus === "completed") {
      seatedAt = seatedAt || nowIso;
      completedAt = nowIso;
    } else if (nextStatus === "cancelled") {
      completedAt = nowIso;
    }

    const updated = normalizeReservation({ ...existing, status: nextStatus, seatedAt, completedAt });
    list[index] = updated;
    writeAllLocalReservations(list, { type: "reservation_updated", reservation: updated });
    return { reservation: updated };
  }

  function createLocalReservation(draft, selectedPlan) {
    if (!selectedPlan) return null;
    const freeTables = availableLocalInventory(draft.date, draft.time);
    const plans = enumeratePlans(freeTables, draft.guestCount);
    const plan = plans.find((c) => c.fourTables === selectedPlan.fourTables && c.twoTables === selectedPlan.twoTables);
    if (!plan) return null;

    const tables = [
      ...freeTables.filter((t) => t.capacity === 4).slice(0, plan.fourTables),
      ...freeTables.filter((t) => t.capacity === 2).slice(0, plan.twoTables),
    ].map((t) => t.id);
    if (tables.length !== plan.tableCount) return null;

    const list = readAllLocalReservations();
    const nextId = list.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    const created = normalizeReservation({
      id: nextId,
      date: draft.date,
      time: draft.time,
      guestCount: draft.guestCount,
      phone: draft.phone,
      tables,
      status: "reserved",
      seatedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
    });
    list.push(created);
    writeAllLocalReservations(list, { type: "reservation_created", reservation: created });
    return created;
  }

  // Lightweight browser-side reservation chat parser for GitHub Pages standalone mode.
  function parseNumber(value) {
    if (/^\d+$/u.test(value)) return Number(value);
    if (!value) return null;
    if (value === "十") return 10;
    if (value.includes("十")) {
      const [tens, ones = ""] = value.split("十");
      const tensVal = !tens || tens === "十" ? 1 : NUMBER_WORDS.get(tens);
      const onesVal = ones ? NUMBER_WORDS.get(ones) : 0;
      if (tensVal === undefined || onesVal === undefined) return null;
      return tensVal * 10 + onesVal;
    }
    return value.length === 1 ? (NUMBER_WORDS.get(value) ?? null) : null;
  }

  function shiftDate(date, days) {
    const shifted = new Date(`${date}T00:00:00.000Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  }

  function validDate(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function dateWithoutYear(month, day, current) {
    const y = Number(current.slice(0, 4));
    const thisYear = validDate(y, month, day);
    if (!thisYear || thisYear >= current) return thisYear;
    return validDate(y + 1, month, day);
  }

  function parseLocalDate(text) {
    const current = localToday();
    if (/今天|今日/u.test(text)) return { value: current };
    if (/後天|后天/u.test(text)) return { value: shiftDate(current, 2) };
    if (/明天|明日/u.test(text)) return { value: shiftDate(current, 1) };

    let m = /(20\d{2})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*日?/u.exec(text);
    if (m) {
      const v = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
      return v ? { value: v } : { invalid: true };
    }
    m = /(?<!\d)(\d{1,2}|[零〇一二兩两三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[零〇一二兩两三四五六七八九十]{1,3})\s*日/u.exec(text);
    if (m) {
      const month = parseNumber(m[1]);
      const day = parseNumber(m[2]);
      if (month === null || day === null) return { invalid: true };
      const v = dateWithoutYear(month, day, current);
      return v ? { value: v } : { invalid: true };
    }
    m = /(?<!\d)(\d{1,2})[/-](\d{1,2})(?!\d)/u.exec(text);
    if (m) {
      const v = dateWithoutYear(Number(m[1]), Number(m[2]), current);
      return v ? { value: v } : { invalid: true };
    }
    return null;
  }

  function parseLocalClock(text) {
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

    const wp = "零〇一二兩两三四五六七八九十";
    const t = new RegExp(`(?:凌晨|早上|上午|中午|午餐|午間|下午|晚上|晚餐|晚間)?\\s*(\\d{1,2}|[${wp}]{1,3})\\s*(?:點|点|時|时)(?:\\s*(半|\\d{1,2}|[${wp}]{1,3})\\s*分?)?`, "u").exec(text);
    if (!t) return null;
    let hour = parseNumber(t[1]);
    const minute = t[2] === "半" ? 30 : (t[2] ? parseNumber(t[2]) : 0);
    if (hour === null || minute === null || hour > 23 || minute > 59) return { invalid: true };
    if (isEvening && hour < 12) hour += 12;
    if (isNoon && hour < 11) hour += 12;
    if (isMorning && hour === 12) hour = 0;
    if (!period && hour >= 1 && hour <= 10) return { ambiguous: true };
    return { value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
  }

  function parseLocalPartySize(text) {
    const combo = /(\d{1,2}|[零〇一二兩两三四五六七八九十]{1,2})\s*大\s*(\d{1,2}|[零〇一二兩两三四五六七八九十]{1,2})\s*小/u.exec(text);
    if (combo) {
      const adults = parseNumber(combo[1]);
      const kids = parseNumber(combo[2]);
      if (adults !== null && kids !== null) return adults + kids;
    }
    const m = /(?:共|總共|總計|人數)?\s*(\d{1,2}|[零〇一二兩两三四五六七八九十]{1,3})\s*(?:位|人|名|個人)/u.exec(text);
    return m ? parseNumber(m[1]) : null;
  }

  function parseLocalPhone(text) {
    const matches = [
      ...(text.match(/(?<!\d)\+?886[- ]?9\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)/gu) ?? []),
      ...(text.match(/(?<!\d)09\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)/gu) ?? []),
      ...(text.match(/(?<!\d)0[2-8]\d?[- ]?\d{3,4}[- ]?\d{4}(?!\d)/gu) ?? []),
    ];
    for (const candidate of matches) {
      let digits = candidate.replace(/\D/gu, "");
      if (digits.startsWith("886")) digits = `0${digits.slice(3)}`;
      if (/^09\d{8}$/u.test(digits) || /^0[2-8]\d{7,9}$/u.test(digits)) return digits;
    }
    return null;
  }

  function planLabel(plan) {
    const parts = [];
    if (plan.fourTables) parts.push(`${plan.fourTables} 張 4 人桌`);
    if (plan.twoTables) parts.push(`${plan.twoTables} 張 2 人桌`);
    return `${parts.join(" + ")}（共 ${plan.capacity} 個座位）`;
  }

  function isWithinHours(time) {
    const total = minutesFromTime(time);
    return (total >= 11 * 60 + 30 && total <= 12 * 60 + 30)
      || (total >= 17 * 60 && total <= 18 * 60);
  }

  function readDrafts() {
    try {
      return JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveDraftFor(userId, state) {
    const all = readDrafts();
    if (!state) delete all[userId];
    else all[userId] = state;
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  }

  function handleLocalChat(userId, message) {
    const started = performance.now();
    const text = message.trim();
    const lower = text.toLowerCase();
    const reply = (body, reservation = null) => ({
      text: body,
      reservation,
      meta: { engine: "browser-demo", model: null },
      elapsedMs: Math.max(1, Math.round(performance.now() - started)),
    });

    if (lower === "/help" || /營業|幾點開|桌位|規則|幫助|說明/u.test(text) && !parseLocalDate(text) && !parseLocalClock(text) && !parseLocalPartySize(text) && !parseLocalPhone(text)) {
      return reply(`您好，這裡是餐廳訂位助理（GitHub Pages 瀏覽器展示模式）。\n\n${RESTAURANT_INFO}\n\n請告訴我訂位日期、時間、人數與聯絡電話，例如：「明天晚上 6 點，四大一小，電話 0912345678」。`);
    }
    if (lower === "/cancel" || /^(取消|不要|放棄|no|cancel)$/iu.test(text)) {
      saveDraftFor(userId, null);
      return reply("已取消目前的訂位流程。若要重新預約，請告訴我日期、時間、人數和電話。");
    }

    const state = readDrafts()[userId] || { draft: { date: "", time: "", guestCount: null, phone: "", planOptions: [] }, awaitingConfirmation: false };
    const draft = { ...state.draft };

    const summary = (plan) => [
      `日期：${draft.date}`,
      `時間：${draft.time}`,
      `人數：${draft.guestCount} 位`,
      `電話：${draft.phone}`,
      plan ? `座位：${planLabel(plan)}` : "",
    ].filter(Boolean).join("\n");

    const confirmText = (plans) => {
      if (draft.guestCount <= 4) {
        return `${summary()}\n\n回覆「確認」完成訂位；如需修改，直接傳送正確資料。`;
      }
      const opts = plans.map((p, i) => `${String.fromCharCode(65 + i)}：${planLabel(p)}`);
      return [`${summary()}\n\n${draft.guestCount} 位需分桌安排，請選擇方案：`, ...opts, plans.length > 1 ? "請回覆 A 或 B（或「第一個方案」）完成訂位，或輸入「取消」。" : "請回覆 A 完成訂位，或輸入「取消」。"].join("\n");
    };

    if (state.awaitingConfirmation) {
      let chosen = null;
      if (draft.guestCount > 4) {
        if (/^(?:方案\s*)?A\b|第一/iu.test(text)) chosen = draft.planOptions[0] ?? null;
        else if (/^(?:方案\s*)?B\b|第二/iu.test(text)) chosen = draft.planOptions[1] ?? null;
        else if (draft.planOptions.length === 1 && /^(確認|好|可以|ok|yes)$/iu.test(text)) chosen = draft.planOptions[0];
      } else if (/^(確認|好|可以|是|沒錯|ok|yes)$/iu.test(text)) {
        chosen = draft.planOptions[0] ?? null;
      }

      if (chosen) {
        const created = createLocalReservation(draft, chosen);
        if (!created) {
          saveDraftFor(userId, { draft: { ...draft, planOptions: [] }, awaitingConfirmation: false });
          return reply("不好意思，這個時段的座位剛被訂走了，請換其他營業時間內的日期與時間。");
        }
        saveDraftFor(userId, null);
        return reply(`訂位完成，訂位編號 #${created.id}\n${summary(chosen)}\n\n每桌用餐時間為 2 小時，期待您的光臨！`, created);
      }
    }

    const d = parseLocalDate(text);
    const t = parseLocalClock(text);
    const g = parseLocalPartySize(text);
    const p = parseLocalPhone(text);

    if (d?.invalid) return reply("日期格式或日期不存在，請重新提供，例如 2026/12/24。");
    if (t?.invalid) return reply("時間格式不正確，請用 24 小時制，例如 12:00 或 18:00。");
    if (t?.ambiguous) return reply("請說明中午或晚上，或直接使用 24 小時制，例如 12:00、18:00。");

    if (d?.value) draft.date = d.value;
    if (t?.value) draft.time = t.value;
    if (g !== null) draft.guestCount = g;
    if (p) draft.phone = p;
    draft.planOptions = [];

    if (!draft.date) {
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply("請問想預約哪一天？可回覆「明天」或「12 月 24 日」。");
    }
    if (draft.date < localToday()) {
      draft.date = "";
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply("請提供今天或之後的日期。");
    }
    if (!draft.time) {
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply("請問想預約幾點？中午為 11:30–12:30，晚上為 17:00–18:00。");
    }
    if (draft.date === localToday() && draft.time <= localNowTime()) {
      draft.time = "";
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply("這個時間已經過了，請提供今天稍晚或其他日期的時間。");
    }
    if (!isWithinHours(draft.time)) {
      draft.time = "";
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply(`您提供的時間不在可訂位時段內。\n${RESTAURANT_INFO}\n\n請重新提供日期與時間。`);
    }
    if (!draft.guestCount) {
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply("請問一共有幾位用餐？");
    }
    if (draft.guestCount > 36) {
      draft.guestCount = null;
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply(`本店最多可安排 36 位，${RESTAURANT_INFO}\n\n請重新提供人數。`);
    }
    if (!draft.phone) {
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply("請提供聯絡電話，例如 0912345678 或 02-12345678。");
    }

    const plans = enumeratePlans(availableLocalInventory(draft.date, draft.time), draft.guestCount);
    if (plans.length === 0) {
      saveDraftFor(userId, { draft, awaitingConfirmation: false });
      return reply(`抱歉，這個時段沒有合適的座位，請換一個時間。\n${RESTAURANT_INFO}`);
    }

    draft.planOptions = plans;
    saveDraftFor(userId, { draft, awaitingConfirmation: true });
    return reply(confirmText(plans));
  }

  // Connection mode & remote/same-origin API client
  function isStaticHost() {
    return window.location.protocol === "file:"
      || window.location.hostname.endsWith(".github.io");
  }

  function normalizeBaseUrl(raw) {
    let text = String(raw || "").trim();
    if (!text) return "";
    if (!/^https?:\/\//iu.test(text)) {
      text = /^(?:localhost|127\.0\.0\.1)(?::|\/|$)/iu.test(text) ? `http://${text}` : `https://${text}`;
    }
    try {
      const parsed = new URL(text);
      return parsed.origin;
    } catch {
      return text.replace(/\/+$/u, "");
    }
  }

  function getConnectionConfig() {
    return {
      url: normalizeBaseUrl(localStorage.getItem(URL_KEY)),
      password: sessionStorage.getItem(PASS_KEY) || "",
    };
  }

  function saveConnectionConfig({ url, password }) {
    const cleanUrl = normalizeBaseUrl(url);
    if (cleanUrl) localStorage.setItem(URL_KEY, cleanUrl);
    else localStorage.removeItem(URL_KEY);

    if (password) sessionStorage.setItem(PASS_KEY, password);
    else sessionStorage.removeItem(PASS_KEY);
  }

  function clearConnectionConfig() {
    localStorage.removeItem(URL_KEY);
    sessionStorage.removeItem(PASS_KEY);
  }

  function getMode() {
    const cfg = getConnectionConfig();
    if (cfg.url) return "remote";
    if (isStaticHost()) return "browser-local";
    return "same-origin";
  }

  function buildAuthHeader(password) {
    if (!password) return "";
    const bytes = new TextEncoder().encode(`owner:${password}`);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
  }

  function apiBase() {
    const mode = getMode();
    if (mode === "remote") return getConnectionConfig().url;
    return "";
  }

  function apiHeaders(extra = {}) {
    const headers = { ...extra };
    if (getMode() === "remote") {
      const auth = buildAuthHeader(getConnectionConfig().password);
      if (auth) headers.Authorization = auth;
    }
    return headers;
  }

  async function fetchDashboard({ date, period, time }) {
    if (getMode() === "browser-local") {
      return getLocalDashboardData(date, time || "all", period);
    }
    const query = new URLSearchParams({ date, period, time: time || "all" });
    const response = await fetch(`${apiBase()}/api/reservations?${query}`, {
      cache: "no-store",
      headers: apiHeaders(),
    });
    if (response.status === 401) throw new Error("後台密碼錯誤或未填寫（請檢查連線設定中的 ADMIN_PASSWORD）。");
    if (!response.ok) throw new Error(`載入訂位資料失敗（HTTP ${response.status}）`);
    return response.json();
  }

  async function patchStatus(id, status) {
    if (getMode() === "browser-local") {
      return updateLocalReservationStatus(id, status);
    }
    const response = await fetch(`${apiBase()}/api/reservations/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ status }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("後台密碼錯誤，無法更新狀態。");
    if (!response.ok) throw new Error(payload.error || `更新狀態失敗（HTTP ${response.status}）`);
    return payload;
  }

  async function sendChat(userId, message) {
    if (getMode() === "browser-local") {
      return handleLocalChat(userId, message);
    }
    const response = await fetch(`${apiBase()}/api/test-chat`, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ userId, message }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("後台密碼錯誤，請在業主後台的「連線設定」輸入正確密碼。");
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  async function fetchHealth() {
    if (getMode() === "browser-local") {
      return { ok: true, mode: "browser-local", ai: { enabled: false, models: [] } };
    }
    const response = await fetch(`${apiBase()}/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function testRemoteConnection({ url, password }) {
    const cleanUrl = normalizeBaseUrl(url);
    if (!cleanUrl) throw new Error("請輸入後端伺服器網址，例如 https://xxxx.trycloudflare.com 或 http://localhost:3000");
    if (!/^https?:\/\//iu.test(cleanUrl)) throw new Error("後端網址須以 http:// 或 https:// 開頭。");
    const today = localToday();
    const auth = buildAuthHeader(password);
    let response;
    try {
      response = await fetch(`${cleanUrl}/api/reservations?date=${today}&period=lunch&time=all`, {
        cache: "no-store",
        headers: auth ? { Authorization: auth } : {},
      });
    } catch {
      throw new Error(
        `無法連上 ${cleanUrl}（網路或瀏覽器 CORS/HTTPS 阻擋）。請確認網址為目前 cloudflared 視窗顯示的 https://xxxx.trycloudflare.com，且本機伺服器仍在執行。`,
      );
    }
    if (response.status === 401) throw new Error("已連上後端，但 ADMIN_PASSWORD 不正確。");
    if (!response.ok) throw new Error(`後端回應異常（HTTP ${response.status}）。`);
    return response.json();
  }

  function openLiveStream({ onConnected, onReservationCreated, onReservationUpdated, onError }) {
    const mode = getMode();

    if (mode === "browser-local") {
      onConnected?.("GitHub Pages 獨立模式（同瀏覽器跨分頁即時同步）");
      const handleStorage = (event) => {
        if (event.key !== EVENT_KEY || !event.newValue) return;
        try {
          const info = JSON.parse(event.newValue);
          if (info.type === "reservation_created" && info.reservation) onReservationCreated?.(info.reservation);
          else onReservationUpdated?.(info.reservation ?? {});
        } catch {}
      };
      const handleLocal = (event) => {
        const info = event.detail || {};
        if (info.type === "reservation_created" && info.reservation) onReservationCreated?.(info.reservation);
        else onReservationUpdated?.(info.reservation ?? {});
      };
      window.addEventListener("storage", handleStorage);
      window.addEventListener("restaurant-local-change", handleLocal);
      return () => {
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener("restaurant-local-change", handleLocal);
      };
    }

    if (mode === "same-origin") {
      const events = new EventSource("/api/events");
      events.addEventListener("connected", () => onConnected?.("即時連線中"));
      events.addEventListener("reservation_created", (e) => onReservationCreated?.(JSON.parse(e.data)));
      events.addEventListener("reservation_updated", (e) => onReservationUpdated?.(JSON.parse(e.data)));
      events.onerror = () => onError?.();
      return () => events.close();
    }

    // Remote authenticated SSE via fetch streaming (supports Authorization header cross-origin)
    let closed = false;
    let controller = null;
    let reconnectTimer = null;

    async function connectRemoteSse() {
      if (closed) return;
      controller = new AbortController();
      try {
        const response = await fetch(`${apiBase()}/api/events`, {
          headers: apiHeaders({ Accept: "text/event-stream" }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        onConnected?.("遠端即時連線中");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            let eventName = "message";
            const dataLines = [];
            for (const line of frame.split(/\r?\n/u)) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length === 0) continue;
            const rawData = dataLines.join("\n");
            try {
              const parsed = JSON.parse(rawData);
              if (eventName === "reservation_created") onReservationCreated?.(parsed);
              else if (eventName === "reservation_updated") onReservationUpdated?.(parsed);
            } catch {}
          }
        }
      } catch {
        if (!closed) onError?.();
      }
      if (!closed) {
        reconnectTimer = setTimeout(connectRemoteSse, 4000);
      }
    }

    connectRemoteSse();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      controller?.abort();
    };
  }

  window.RestaurantBridge = {
    SERVICE_PERIODS,
    localToday,
    isStaticHost,
    getMode,
    getConnectionConfig,
    saveConnectionConfig,
    clearConnectionConfig,
    testRemoteConnection,
    fetchDashboard,
    patchStatus,
    sendChat,
    fetchHealth,
    openLiveStream,
    seedDemoData,
    clearLocalData,
  };
})();
