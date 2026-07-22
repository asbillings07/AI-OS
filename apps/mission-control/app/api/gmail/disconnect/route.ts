import { NextResponse } from "next/server";
import { getGmailIntegration } from "../../../../lib/gmail-auth";
import { isSameOrigin } from "../state";

export const dynamic = "force-dynamic";

/**
 * Revoke (best-effort) and delete the stored Gmail credential. State-changing,
 * so it is POST-only and guarded by a same-origin check — Mission Control has no
 * user session, so this is the CSRF defense for the mutation.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const service = getGmailIntegration().service();
  if (service) {
    await service.disconnect();
  }

  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
