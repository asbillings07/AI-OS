import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getGmailIntegration } from "../../../../lib/gmail-auth";
import { OAUTH_STATE_COOKIE } from "../state";

export const dynamic = "force-dynamic";

/**
 * Begin the Google consent flow. We mint a cryptographically random state,
 * remember it in an HttpOnly cookie (CSRF defense per Google's guidance), and
 * redirect to Google. The callback compares the returned state against this
 * cookie before trusting the code.
 */
export async function GET(): Promise<NextResponse> {
  const service = getGmailIntegration().service();
  if (!service) {
    // Not in live mode, or misconfigured: nothing to connect.
    return NextResponse.json(
      { error: "Gmail live mode is not configured." },
      { status: 400 },
    );
  }

  const state = randomBytes(32).toString("base64url");
  const response = NextResponse.redirect(service.authorizationUrl(state));
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: service.redirectIsHttps,
    path: "/",
    maxAge: 600,
  });
  return response;
}
