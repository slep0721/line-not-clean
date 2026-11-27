import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadLocalEnv() {
  const envPath = path.join(projectRoot, ".env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少必要環境變數：${name}。請複製 .env.example 為 .env 並填入設定。`);
  return value;
}

function parsePositiveInt(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function buildGeminiModels() {
  const primary = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  const rawFallbacks = process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.6-flash,gemini-3.5-flash-lite";
  const fallbacks = rawFallbacks
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const unique = [];
  for (const model of [primary, ...fallbacks]) {
    if (model && !unique.includes(model)) unique.push(model);
  }
  return Object.freeze(unique);
}

function buildCorsOrigins() {
  const raw = process.env.CORS_ORIGINS ?? "https://slep0721.github.io";
  return Object.freeze(
    raw
      .split(",")
      .map((item) => item.trim().replace(/\/+$/u, ""))
      .filter(Boolean),
  );
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT 必須是 1 到 65535 之間的連接埠號碼。");
}

const databasePath = process.env.DATABASE_PATH?.trim() || "data/reservations.sqlite";
const adminPassword = required("ADMIN_PASSWORD");
if (adminPassword.length < 20 || /replace-this|change-me/iu.test(adminPassword)) {
  throw new Error("ADMIN_PASSWORD 至少需要 20 個字元，請設定一組隨機密碼。");
}

export const config = Object.freeze({
  lineChannelSecret: required("LINE_CHANNEL_SECRET"),
  lineChannelAccessToken: required("LINE_CHANNEL_ACCESS_TOKEN"),
  adminPassword,
  port,
  timeZone: process.env.TIME_ZONE?.trim() || "Asia/Taipei",
  databasePath: path.resolve(projectRoot, databasePath),
  corsOrigins: buildCorsOrigins(),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || "",
  geminiModels: buildGeminiModels(),
  geminiTimeoutMs: parsePositiveInt(process.env.GEMINI_TIMEOUT_MS, 8000, 1500, 20000),
  geminiTotalBudgetMs: parsePositiveInt(process.env.GEMINI_TOTAL_BUDGET_MS, 18000, 4000, 35000),
  geminiCooldownMs: parsePositiveInt(process.env.GEMINI_COOLDOWN_MS, 60000, 5000, 600000),
});
