import type { ContextState } from "../understanding/context.js";

/**
 * Capacity (ubiquitous language): Orion's current estimate of how effectively
 * the user can make progress *right now*. It answers *"can the user act well
 * right now?"* — a property of the user, independent of any Opportunity's value.
 *
 * Capacity is the *estimate*, not the evidence. v0.1 infers it from two coarse,
 * deterministic signals (time of day and current open load); richer evidence
 * (focus depth, interruption risk, device, connectivity) is deferred (Eng #9).
 */
export interface Capacity {
  /** 0..1 — higher means better able to act well now. */
  level: number;
  evidence: string[];
}

/** Rough time-of-day suitability for focused work (UTC-based, deterministic). */
function timeOfDayScore(hourUtc: number): { score: number; note: string } {
  if (hourUtc >= 13 && hourUtc <= 22) {
    return { score: 0.85, note: "Within typical working hours." };
  }
  if (hourUtc >= 11 && hourUtc <= 23) {
    return { score: 0.6, note: "Near the edges of the working day." };
  }
  return { score: 0.3, note: "Outside typical working hours." };
}

/**
 * Estimate Capacity. Deterministic given `now`. Optional Context lets a heavy
 * open load lower Capacity — it is harder to act well when many things are open.
 */
export function estimateCapacity(now: string, context?: ContextState): Capacity {
  const hourUtc = new Date(now).getUTCHours();
  const time = timeOfDayScore(hourUtc);
  const evidence = [time.note];

  let level = time.score;

  if (context) {
    const openThreads = Object.values(context.threads).filter((thread) => thread.status === "open").length;
    if (openThreads >= 6) {
      level -= 0.25;
      evidence.push(`Heavy current load (${openThreads} open conversations).`);
    } else if (openThreads <= 2) {
      level += 0.1;
      evidence.push("Light current load.");
    }
  }

  return { level: Math.max(0, Math.min(1, level)), evidence };
}
