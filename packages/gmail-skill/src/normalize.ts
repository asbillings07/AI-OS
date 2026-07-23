import type { EmailAddress, MessageReceivedPayload, MessageSentPayload } from "@orion/core";
import type { RawGmailMessage, RawGmailHeader } from "@orion/fixtures";

export type NormalizedGmailMessage =
  | { direction: "received"; payload: MessageReceivedPayload }
  | { direction: "sent"; payload: MessageSentPayload };

function headerValue(headers: RawGmailHeader[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").trim();
}

export function parseAddress(raw: string): EmailAddress {
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1] ? stripQuotes(match[1]) : "";
    const address = (match[2] ?? "").trim().toLowerCase();
    return name ? { name, address } : { address };
  }
  return { address: raw.trim().toLowerCase() };
}

/**
 * Split an address-list header on commas that are NOT inside a quoted display
 * name. A plain `split(",")` corrupts common forms like
 * `"Doe, John" <john@example.com>`, which would otherwise add a bogus "doe"
 * participant and skew relationship/signal detection.
 */
function splitAddressList(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function parseAddressList(raw: string | undefined): EmailAddress[] {
  if (!raw) return [];
  return splitAddressList(raw)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseAddress);
}

function decodePlainTextBody(message: RawGmailMessage): string {
  const part = message.payload.parts?.find((candidate) => candidate.mimeType === "text/plain");
  const data = part?.body?.data ?? message.payload.body?.data;
  if (!data) {
    return message.snippet;
  }
  return Buffer.from(data, "base64url").toString("utf8").trim();
}

function receivedAt(message: RawGmailMessage): string {
  if (message.internalDate) {
    const epoch = Number(message.internalDate);
    if (Number.isFinite(epoch)) {
      return new Date(epoch).toISOString();
    }
  }
  const dateHeader = headerValue(message.payload.headers, "Date");
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

/**
 * Normalize a Gmail-shaped message into the domain's MessageReceived or MessageSent payload.
 *
 * Precedence Rule: If `message.labelIds` includes `"SENT"`, normalize as `direction: "sent"`
 * (even if `INBOX` is also present, e.g. self-addressed mail). Otherwise `direction: "received"`.
 *
 * This is where the vendor shape stops: everything downstream sees only domain
 * concepts (Eng #8, ADR-0010). The Skill disappears.
 */
export function normalizeGmailMessage(message: RawGmailMessage): NormalizedGmailMessage {
  const headers = message.payload.headers;
  const from = parseAddress(headerValue(headers, "From") ?? "unknown@unknown");
  const to = parseAddressList(headerValue(headers, "To"));
  const subject = headerValue(headers, "Subject") ?? "(no subject)";
  const snippet = message.snippet;
  const body = decodePlainTextBody(message);
  const timeIso = receivedAt(message);

  const isSent = message.labelIds?.includes("SENT") ?? false;
  if (isSent) {
    return {
      direction: "sent",
      payload: {
        messageId: message.id,
        threadId: message.threadId,
        from,
        to,
        subject,
        snippet,
        body,
        sentAt: timeIso,
      },
    };
  }

  return {
    direction: "received",
    payload: {
      messageId: message.id,
      threadId: message.threadId,
      from,
      to,
      subject,
      snippet,
      body,
      receivedAt: timeIso,
    },
  };
}
