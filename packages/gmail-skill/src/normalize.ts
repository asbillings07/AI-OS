import type { EmailAddress, MessageReceivedPayload } from "@orion/core";
import type { RawGmailMessage, RawGmailHeader } from "@orion/fixtures";

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

function parseAddressList(raw: string | undefined): EmailAddress[] {
  if (!raw) return [];
  return raw
    .split(",")
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
 * Normalize a Gmail-shaped message into the domain's MessageReceived payload.
 * This is where the vendor shape stops: everything downstream sees only domain
 * concepts (Eng #8, ADR-0010). The Skill disappears.
 */
export function normalizeGmailMessage(message: RawGmailMessage): MessageReceivedPayload {
  const headers = message.payload.headers;
  const from = parseAddress(headerValue(headers, "From") ?? "unknown@unknown");
  return {
    messageId: message.id,
    threadId: message.threadId,
    from,
    to: parseAddressList(headerValue(headers, "To")),
    subject: headerValue(headers, "Subject") ?? "(no subject)",
    snippet: message.snippet,
    body: decodePlainTextBody(message),
    receivedAt: receivedAt(message),
  };
}
