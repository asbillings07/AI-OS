import { timingSafeEqual } from "node:crypto";

/** The short-lived, HttpOnly cookie holding the OAuth CSRF state. */
export const OAUTH_STATE_COOKIE = "orion_oauth_state";

/**
 * Constant-time compare for EQUAL-LENGTH inputs; a length mismatch short-circuits
 * to false (and does leak length). That is acceptable here because the OAuth
 * state is always a fixed-length random token, so its length carries no secret.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * True when a state-changing request's Origin matches its Host (a lightweight
 * CSRF check for the Disconnect POST). A missing Origin is rejected.
 */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
