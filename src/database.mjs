import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.mjs";

mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const SERVICE_PERIODS = Object.freeze({
  lunch: Object.freeze({
    id: "lunch",
    label: "中午時段",
    open: "11:30",
    close: "14:30",
    lastSeating: "12:30",
    startMinutes: 11 * 60 + 30,
    endMinutes: 14 * 60 + 30,
    slots: Object.freeze(["11:30", "12:00", "12:30", "13:00", "13:30", "14:00"]),
  }),
  dinner: Object.freeze({
    id: "dinner",
    label: "晚上時段",
    open: "17:00",
    close: "20:00",
    lastSeating: "18:00",
    startMinutes: 17 * 60,
    endMinutes: 20 * 60,
    slots: Object.freeze(["17:00", "17:30", "18:00", "18:30", "19:00", "19:30"]),
  }),
});

export const RESERVATION_STATUSES = Object.freeze(["reserved", "seated", "completed", "cancelled"]);

export const database = new DatabaseSync(config.databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    line_user_id TEXT PRIMARY KEY,
    draft_json TEXT NOT NULL,
    awaiting_confirmation INTEGER NOT NULL DEFAULT 0,
    last_assistant_message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_date TEXT NOT NULL,
    reservation_time TEXT NOT NULL,
    guest_count INTEGER NOT NULL,
    phone TEXT NOT NULL,
    tables_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved',
    seated_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS reservations_by_date_time
    ON reservations(reservation_date, reservation_time);

  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    received_at TEXT NOT NULL,
    completed_at TEXT
  );
`);

// Safe migration for databases created before status tracking columns existed.
const reservationColumns = new Set(
  database.prepare("PRAGMA table_info(reservations)").all().map((column) => column.name),
);
if (!reservationColumns.has("status")) {
  database.exec("ALTER TABLE reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'reserved'");
}
if (!reservationColumns.has("seated_at")) {
  database.exec("ALTER TABLE reservations ADD COLUMN seated_at TEXT");
}
if (!reservationColumns.has("completed_at")) {
  database.exec("ALTER TABLE reservations ADD COLUMN completed_at TEXT");
}

const tableInventory = [
  ...Array.from({ length: 6 }, (_, index) => ({ id: `4-${index + 1}`, capacity: 4 })),
  ...Array.from({ length: 6 }, (_, index) => ({ id: `2-${index + 1}`, capacity: 2 })),
];

const getConversationStatement = database.prepare(`
  SELECT draft_json, awaiting_confirmation, last_assistant_message
  FROM conversations WHERE line_user_id = ?
`);
const saveConversationStatement = database.prepare(`
  INSERT INTO conversations (line_user_id, draft_json, awaiting_confirmation, last_assistant_message, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(line_user_id) DO UPDATE SET
    draft_json = excluded.draft_json,
    awaiting_confirmation = excluded.awaiting_confirmation,
    last_assistant_message = excluded.last_assistant_message,
    updated_at = excluded.updated_at
`);
const deleteConversationStatement = database.prepare("DELETE FROM conversations WHERE line_user_id = ?");
const listReservationsStatement = database.prepare(`
  SELECT id, reservation_date, reservation_time, guest_count, phone, tables_json, status, seated_at, completed_at, created_at
  FROM reservations WHERE reservation_date = ? ORDER BY reservation_time, id
`);
const getReservationByIdStatement = database.prepare(`
  SELECT id, reservation_date, reservation_time, guest_count, phone, tables_json, status, seated_at, completed_at, created_at
  FROM reservations WHERE id = ?
`);
const insertReservationStatement = database.prepare(`
  INSERT INTO reservations (reservation_date, reservation_time, guest_count, phone, tables_json, status, seated_at, completed_at, created_at)
  VALUES (?, ?, ?, ?, ?, 'reserved', NULL, NULL, ?)
`);
const updateReservationStatusStatement = database.prepare(`
  UPDATE reservations
  SET status = ?, seated_at = ?, completed_at = ?
  WHERE id = ?
`);
const claimEventStatement = database.prepare(`
  INSERT OR IGNORE INTO webhook_events (event_id, status, received_at)
  VALUES (?, 'processing', ?)
`);
const markEventDoneStatement = database.prepare(
  "UPDATE webhook_events SET status = 'done', completed_at = ? WHERE event_id = ?",
);

function minutesFromTime(value) {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

function addMinutesToTime(value, deltaMinutes) {
  const minutes = minutesFromTime(value);
  if (Number.isNaN(minutes)) return "";
  const total = (minutes + deltaMinutes) % (24 * 60);
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatLocalClock(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.valueOf())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${map.hour}:${map.minute}`;
}

export function getServicePeriod(time) {
  const minutes = minutesFromTime(time);
  if (Number.isNaN(minutes)) return "lunch";
  return minutes < 15 * 60 ? "lunch" : "dinner";
}

export function isBlockingStatus(status) {
  return status === "reserved" || status === "seated";
}

function mapReservation(row) {
  const status = RESERVATION_STATUSES.includes(row.status) ? row.status : "reserved";
  const seatedTime = formatLocalClock(row.seated_at);
  const endTime = addMinutesToTime(row.reservation_time, 120);
  const expectedEndTime = status === "seated" && seatedTime
    ? addMinutesToTime(seatedTime, 120)
    : endTime;

  return {
    id: Number(row.id),
    date: row.reservation_date,
    time: row.reservation_time,
    endTime,
    expectedEndTime,
    period: getServicePeriod(row.reservation_time),
    guestCount: Number(row.guest_count),
    phone: row.phone,
    tables: JSON.parse(row.tables_json),
    status,
    seatedAt: row.seated_at ?? null,
    seatedTime,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
  };
}

// Checks whether a 2-hour reservation starting at candidateTime conflicts with an existing 2-hour reservation.
export function conflictsWithReservation(reservation, candidateTime) {
  const existingStart = minutesFromTime(reservation.time);
  const candidateStart = minutesFromTime(candidateTime);
  if (Number.isNaN(existingStart) || Number.isNaN(candidateStart)) return false;
  return Math.abs(existingStart - candidateStart) < 120;
}

// Checks whether a table is occupied at a specific point in time (used by the admin floor plan).
export function isOccupiedAt(reservation, selectedTime) {
  const start = minutesFromTime(reservation.time);
  const selected = minutesFromTime(selectedTime);
  if (Number.isNaN(start) || Number.isNaN(selected)) return false;
  return start <= selected && selected < start + 120;
}

// Checks whether a reservation overlaps a business service period window [startMinutes, endMinutes).
function overlapsPeriod(reservation, periodConfig) {
  const start = minutesFromTime(reservation.time);
  if (Number.isNaN(start)) return false;
  return start < periodConfig.endMinutes && periodConfig.startMinutes < start + 120;
}

function availableInventory(date, time, excludeReservationId = null) {
  const busy = new Set(
    listReservationsStatement.all(date)
      .map(mapReservation)
      .filter((reservation) => reservation.id !== excludeReservationId)
      .filter((reservation) => isBlockingStatus(reservation.status))
      .filter((reservation) => conflictsWithReservation(reservation, time))
      .flatMap((reservation) => reservation.tables),
  );
  return tableInventory.filter((table) => !busy.has(table.id));
}

function enumeratePlans(availableTables, guestCount) {
  const availableFour = availableTables.filter((table) => table.capacity === 4).length;
  const availableTwo = availableTables.filter((table) => table.capacity === 2).length;
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

  plans.sort((left, right) =>
    left.tableCount - right.tableCount
    || (left.capacity - guestCount) - (right.capacity - guestCount)
    || right.fourTables - left.fourTables,
  );

  if (plans.length === 0) return [];
  const fewestTables = plans[0].tableCount;
  return plans.filter((plan) => plan.tableCount === fewestTables).slice(0, 2);
}

function reserveTables(date, time, guestCount, phone, selectedPlan) {
  if (!selectedPlan) return null;
  database.exec("BEGIN IMMEDIATE");
  try {
    const freeTables = availableInventory(date, time);
    const plans = enumeratePlans(freeTables, guestCount);
    const plan = plans.find((candidate) =>
      candidate.fourTables === selectedPlan.fourTables && candidate.twoTables === selectedPlan.twoTables,
    );
    if (!plan) {
      database.exec("ROLLBACK");
      return null;
    }

    const tables = [
      ...freeTables.filter((table) => table.capacity === 4).slice(0, plan.fourTables),
      ...freeTables.filter((table) => table.capacity === 2).slice(0, plan.twoTables),
    ].map((table) => table.id);

    if (tables.length !== plan.tableCount) {
      database.exec("ROLLBACK");
      return null;
    }

    const createdAt = new Date().toISOString();
    const result = insertReservationStatement.run(
      date,
      time,
      guestCount,
      phone,
      JSON.stringify(tables),
      createdAt,
    );
    database.exec("COMMIT");
    return mapReservation(getReservationByIdStatement.get(Number(result.lastInsertRowid)));
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function summarizeReservations(list) {
  const reserved = list.filter((item) => item.status === "reserved");
  const seated = list.filter((item) => item.status === "seated");
  const completed = list.filter((item) => item.status === "completed");
  const cancelled = list.filter((item) => item.status === "cancelled");
  const active = [...reserved, ...seated];
  const effective = [...active, ...completed];
  const sumGuests = (items) => items.reduce((total, item) => total + item.guestCount, 0);

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

export function getConversation(userId) {
  const row = getConversationStatement.get(userId);
  if (!row) return { draft: null, awaitingConfirmation: false, lastAssistantMessage: "" };
  return {
    draft: JSON.parse(row.draft_json),
    awaitingConfirmation: row.awaiting_confirmation === 1,
    lastAssistantMessage: row.last_assistant_message,
  };
}

export function saveConversation(userId, { draft, awaitingConfirmation, lastAssistantMessage }) {
  saveConversationStatement.run(
    userId,
    JSON.stringify(draft),
    awaitingConfirmation ? 1 : 0,
    lastAssistantMessage,
    new Date().toISOString(),
  );
}

export function clearConversation(userId) {
  deleteConversationStatement.run(userId);
}

export function getTablePlans(date, time, guestCount) {
  if (guestCount < 1 || guestCount > 36) return [];
  return enumeratePlans(availableInventory(date, time), guestCount);
}

export function createReservation(details, plan) {
  return reserveTables(details.date, details.time, details.guestCount, details.phone, plan);
}

export function updateReservationStatus(id, nextStatus) {
  if (!RESERVATION_STATUSES.includes(nextStatus)) {
    return { error: "INVALID_STATUS" };
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const existingRow = getReservationByIdStatement.get(id);
    if (!existingRow) {
      database.exec("ROLLBACK");
      return { error: "NOT_FOUND" };
    }
    const existing = mapReservation(existingRow);

    // Prevent double-booking if restoring a completed/cancelled reservation whose tables were taken.
    if (!isBlockingStatus(existing.status) && isBlockingStatus(nextStatus)) {
      const freeIds = new Set(availableInventory(existing.date, existing.time, existing.id).map((table) => table.id));
      const allFree = existing.tables.every((tableId) => freeIds.has(tableId));
      if (!allFree) {
        database.exec("ROLLBACK");
        return { error: "TABLE_CONFLICT" };
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

    updateReservationStatusStatement.run(nextStatus, seatedAt, completedAt, id);
    const updated = mapReservation(getReservationByIdStatement.get(id));
    database.exec("COMMIT");
    return { reservation: updated };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getDashboardData(date, time = "all", requestedPeriod = "") {
  const resolvedPeriod = requestedPeriod === "lunch" || requestedPeriod === "dinner"
    ? requestedPeriod
    : (time && time !== "all" ? getServicePeriod(time) : "lunch");
  const periodConfig = SERVICE_PERIODS[resolvedPeriod];
  const resolvedTime = time && time !== "all" ? time : "all";

  const reservations = listReservationsStatement.all(date).map(mapReservation);
  const occupyingReservations = reservations
    .filter((reservation) => isBlockingStatus(reservation.status))
    .filter((reservation) =>
      resolvedTime === "all"
        ? overlapsPeriod(reservation, periodConfig)
        : isOccupiedAt(reservation, resolvedTime),
    );

  const tableOccupancy = new Map();
  for (const reservation of occupyingReservations) {
    for (const tableId of reservation.tables) {
      const current = tableOccupancy.get(tableId);
      if (!current || (current.status !== "seated" && reservation.status === "seated")) {
        tableOccupancy.set(tableId, reservation);
      }
    }
  }

  const tables = tableInventory.map((table) => {
    const active = tableOccupancy.get(table.id) ?? null;
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

  const lunchReservations = reservations.filter((reservation) => reservation.period === "lunch");
  const dinnerReservations = reservations.filter((reservation) => reservation.period === "dinner");
  const periodReservations = resolvedPeriod === "lunch" ? lunchReservations : dinnerReservations;
  const nextUpcoming = periodReservations.find((reservation) => reservation.status === "reserved")
    ?? reservations.find((reservation) => reservation.status === "reserved")
    ?? null;

  const availableTables = tables.filter((table) => table.state === "available");
  const reservedTables = tables.filter((table) => table.state === "reserved");
  const seatedTables = tables.filter((table) => table.state === "seated");

  return {
    date,
    period: resolvedPeriod,
    time: resolvedTime,
    reservations,
    periods: {
      lunch: {
        ...SERVICE_PERIODS.lunch,
        reservations: lunchReservations,
        summary: summarizeReservations(lunchReservations),
      },
      dinner: {
        ...SERVICE_PERIODS.dinner,
        reservations: dinnerReservations,
        summary: summarizeReservations(dinnerReservations),
      },
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
        availableSeats: availableTables.reduce((sum, table) => sum + table.capacity, 0),
        totalSeats: tables.reduce((sum, table) => sum + table.capacity, 0),
      },
      nextUpcoming,
    },
    tables,
  };
}

export function claimWebhookEvent(eventId) {
  return Number(claimEventStatement.run(eventId, new Date().toISOString()).changes) === 1;
}

export function completeWebhookEvent(eventId) {
  markEventDoneStatement.run(new Date().toISOString(), eventId);
}
