/**
 * Deterministic authorization + reply-matching helpers for src/api.
 * Never trust the model: every check here is keyed off the authenticated
 * DingTalk sender/operator ID, not anything the agent said.
 */
import type { ApproverScope, Config } from "../shared/types.ts";

export function isAdmin(cfg: Config, id: string): boolean {
  return cfg.admins.includes(id);
}

export function isEditor(editors: string[] | undefined, cfg: Config, id: string): boolean {
  return isAdmin(cfg, id) || (editors ?? []).includes(id);
}

/** approverScope check for pending-question / approval answers (reply or reaction). */
export function canApprove(
  scope: ApproverScope,
  operatorId: string,
  requesterId: string,
  editors: string[] | undefined,
  cfg: Config,
): boolean {
  if (scope === "requester") return operatorId === requesterId;
  if (scope === "editors") return isEditor(editors, cfg, operatorId);
  return isAdmin(cfg, operatorId); // "admins"
}

const THUMBS_UP = new Set(["thumbsup", "thumbs-up", "thumbs_up", "like", "+1"]);
const THUMBS_DOWN = new Set(["thumbsdown", "thumbs-down", "thumbs_down", "-1"]);

/**
 * Map a reaction's emoji name to an option index.
 * thumbs-up/like -> option 0 always; thumbs-down -> option 1 only for
 * 2-option questions (ambiguous otherwise); numeric keycap names "1".."4"
 * -> that index when in range.
 */
export function emojiToOption(emoji: string, numOptions: number): number | undefined {
  const e = emoji.trim().toLowerCase();
  if (THUMBS_UP.has(e)) return 0;
  if (numOptions === 2 && THUMBS_DOWN.has(e)) return 1;
  const trimmed = emoji.trim();
  if (/^[1-4]$/.test(trimmed)) {
    const idx = Number(trimmed) - 1;
    return idx < numOptions ? idx : undefined;
  }
  return undefined;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Exact option number, or a fuzzy (normalized) match against option text.
 * Only `o.startsWith(r)` (reply is a leading abbreviation of the option,
 * e.g. "appr" -> "Approve") — never a bare substring test in either
 * direction: `r.includes(o)` would let a negated reply like "don't approve"
 * (normalizes to "dontapprove") match "Approve", and `o.includes(r)` would
 * let a short unrelated reply like "ok" match "Book flights" (contains
 * "ok" mid-string).
 */
export function matchReply(reply: string, options: string[]): number | undefined {
  const trimmed = reply.trim();
  const n = Number(trimmed);
  if (trimmed !== "" && Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  const r = normalize(reply);
  if (!r) return undefined;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (opt === undefined) continue;
    const o = normalize(opt);
    if (o && (o === r || o.startsWith(r))) return i;
  }
  return undefined;
}
