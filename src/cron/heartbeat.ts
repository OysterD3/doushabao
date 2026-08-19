/**
 * Dead-man heartbeat watchdog logic. `checkQuiet` is a pure function so the
 * quiet-stream detection can be unit tested without waiting on real timers;
 * `runHeartbeatCheck` wires it to the alert send + 6h throttle.
 */
import type { Config, DwsPort } from "../shared/types.ts";

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(now: number, timezone: string): { hour: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    // h23 avoids the Intl "24" quirk some locales use for midnight under hour12:false.
    hourCycle: "h23",
    hour: "numeric",
    weekday: "short",
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return { hour, day: WEEKDAY_INDEX[weekday] ?? 0 };
}

/** True when `now` falls inside cfg.heartbeat.workHours, local to cfg.timezone. */
export function isWithinWorkHours(now: number, cfg: Config): boolean {
  const { hour, day } = localParts(now, cfg.timezone);
  const { start, end, days } = cfg.heartbeat.workHours;
  return days.includes(day) && hour >= start && hour < end;
}

/**
 * Pure quiet-stream detector: true when an alert condition is met — inside
 * work hours AND no inbound event for longer than quietMinutes. `lastEventAt`
 * being NaN (e.g. the file is missing) safely yields false, never true.
 */
export function checkQuiet(now: number, lastEventAt: number, cfg: Config): boolean {
  if (!isWithinWorkHours(now, cfg)) return false;
  return now - lastEventAt > cfg.heartbeat.quietMinutes * 60_000;
}

export interface HeartbeatDeps {
  cfg: Config;
  dws: DwsPort;
}

export interface HeartbeatState {
  /** Epoch ms of the last alert actually sent; 0 = never. Kept in-memory only
   * (no sanctioned durable path for it) — resets on daemon restart. */
  lastAlertAt: number;
}

const ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000;

/**
 * Runs one heartbeat tick: alerts every cfg.admin via dws DM when the stream
 * looks quiet, throttled to at most one alert per 6h. Returns true when at
 * least one alert send was attempted. A failed send to one admin does not
 * skip the rest; the throttle timestamp is only set once a send is attempted
 * (not per-admin), matching the "at most one alert per 6h" binding decision.
 */
export async function runHeartbeatCheck(
  deps: HeartbeatDeps,
  state: HeartbeatState,
  now: number,
  lastEventAt: number,
): Promise<boolean> {
  if (!checkQuiet(now, lastEventAt, deps.cfg)) return false;
  if (now - state.lastAlertAt < ALERT_THROTTLE_MS) return false;
  state.lastAlertAt = now;
  const text = `[doushabao] No inbound DingTalk events for over ${deps.cfg.heartbeat.quietMinutes} minutes during work hours. The event listener may be down.`;
  for (const adminId of deps.cfg.admins) {
    try {
      await deps.dws.sendText(adminId, "dm", text);
    } catch (err) {
      console.error(`cron: heartbeat alert to ${adminId} failed: ${(err as Error).message}`);
    }
  }
  return true;
}
