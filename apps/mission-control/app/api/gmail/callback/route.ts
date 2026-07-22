import { NextResponse } from "next/server";
import {
  AccountMismatchError,
  CallbackRejectedError,
} from "@orion/gmail-auth";
import { getGmailIntegration } from "../../../../lib/gmail-auth";
import { OAUTH_STATE_COOKIE, timingSafeEqualString } from "../state";

export const dynamic = "force-dynamic";

/**
 * The OAuth redirect target. This route owns CSRF: it validates the returned
 * `state` against the HttpOnly cookie (timing-safe) before handing the code to
 * the authorization service, and clears the cookie on every outcome — success,
 * denial, malformed callback, or failure.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const params = requestUrl.searchParams;
  const cookieState = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OAUTH_STATE_COOKIE}=`))
    ?.slice(OAUTH_STATE_COOKIE.length + 1);

  const finish = (status: string): NextResponse => {
    const home = new URL("/", requestUrl.origin);
    home.searchParams.set("gmail", status);
    const response = NextResponse.redirect(home);
    response.cookies.delete(OAUTH_STATE_COOKIE);
    return response;
  };

  const service = getGmailIntegration().service();
  if (!service) return finish("not_configured");

  // The user denied consent (or Google reported an error).
  const oauthError = params.get("error");
  if (oauthError) return finish("denied");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !cookieState || !timingSafeEqualString(state, cookieState)) {
    return finish("state_mismatch");
  }

  try {
    await service.handleCallback(code);
    return finish("connected");
  } catch (error) {
    if (error instanceof AccountMismatchError) return finish("account_mismatch");
    if (error instanceof CallbackRejectedError) return finish("rejected");
    return finish("error");
  }
}
