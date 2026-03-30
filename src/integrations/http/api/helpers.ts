import { telemetry } from "../../../services/infrastructure/telemetry";

export const apiTelemetry = telemetry.child({ component: "http_api" });

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export function formatUptime(startedAt?: string, createdAt?: string): string {
  const ref = startedAt ?? createdAt;
  if (!ref) return "0m";
  const ms = Date.now() - new Date(ref).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`;
}

export function truncateGoal(goal: string, maxLen = 60): string {
  return goal.length > maxLen ? goal.slice(0, maxLen - 1) + "\u2026" : goal;
}
