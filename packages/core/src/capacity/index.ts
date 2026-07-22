/**
 * Capacity (ubiquitous language): Orion's current estimate of how effectively
 * the user can make progress *right now*. It answers *"can the user act well
 * right now?"* — a property of the user, independent of any Opportunity's value.
 *
 * Capacity is the *estimate*, not the evidence. v0.1 infers it from two coarse,
 * deterministic signals (time of day and current load); richer evidence
 * (focus depth, interruption risk, device, connectivity) is deferred (Eng #9).
 */
export interface Capacity {
  /** 0..1 — higher means better able to act well now. */
  level: number;
  evidence: string[];
}

/**
 * Source-neutral load input. `activeWorkCount` is **attention demand** — the
 * number of Work Items Orion is currently asking the user to consider — NOT
 * everything unresolved in the outside world. Dismissed/snoozed items don't count
 * while hidden and re-enter load when they resurface. Capacity does not know that
 * work happens to be stored as email threads, reviews, or checks.
 */
export interface CapacityLoad {
  readonly activeWorkCount: number;
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
 * Estimate Capacity. Deterministic given `now`. Optional load lets a heavy
 * attention demand lower Capacity — it is harder to act well when Orion is asking
 * you to consider many things at once.
 *
 * Thresholds are tuned for *visible attention demand* (a smaller population than
 * "all open conversations" was): heavy at >= 4, light at <= 1.
 */
export function estimateCapacity(now: string, load?: CapacityLoad): Capacity {
  const hourUtc = new Date(now).getUTCHours();
  const time = timeOfDayScore(hourUtc);
  const evidence = [time.note];

  let level = time.score;

  if (load) {
    const { activeWorkCount } = load;
    if (activeWorkCount >= 4) {
      level -= 0.25;
      evidence.push(`Heavy current load (${activeWorkCount} things need you).`);
    } else if (activeWorkCount <= 1) {
      level += 0.1;
      evidence.push("Light current load.");
    }
  }

  return { level: Math.max(0, Math.min(1, level)), evidence };
}
