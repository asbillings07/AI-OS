/**
 * Captured, Gmail-shaped sample messages for fixtures-first, key-free runs
 * (ADR-0009). The shape mirrors the Gmail API's `users.messages.get` (full
 * format): headers, base64url-encoded bodies, `internalDate` in epoch ms. This
 * vendor shape lives here and in the Gmail Skill only — it never reaches the
 * domain (Eng #8).
 */

export interface RawGmailHeader {
  name: string;
  value: string;
}

export interface RawGmailBody {
  data?: string;
  size?: number;
}

export interface RawGmailPart {
  mimeType: string;
  body?: RawGmailBody;
}

export interface RawGmailPayload {
  mimeType: string;
  headers: RawGmailHeader[];
  body?: RawGmailBody;
  parts?: RawGmailPart[];
}

export interface RawGmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  snippet: string;
  payload: RawGmailPayload;
}

interface MessageSpec {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  labelIds?: string[];
}

function gmailMessage(spec: MessageSpec): RawGmailMessage {
  return {
    id: spec.id,
    threadId: spec.threadId,
    internalDate: Date.parse(spec.date).toString(),
    labelIds: spec.labelIds ?? ["INBOX"],
    snippet: spec.body.slice(0, 100),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: spec.from },
        { name: "To", value: spec.to },
        { name: "Subject", value: spec.subject },
        { name: "Date", value: new Date(spec.date).toUTCString() },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: {
            // Gmail encodes bodies as base64url; the Skill must decode it.
            data: Buffer.from(spec.body, "utf8").toString("base64url"),
          },
        },
      ],
    },
  };
}

const ME = "me@orion.dev";

/**
 * A deliberately varied inbox: real people awaiting replies, an aging thread, a
 * known correspondent, an FYI with no ask, and automated senders that should
 * produce silence — enough to exercise the whole pipeline end to end.
 */
export const gmailMessages: RawGmailMessage[] = [
  gmailMessage({
    id: "g-dana-1",
    threadId: "th-dana",
    from: "Dana Lee <dana@acme.com>",
    to: ME,
    subject: "Can you review the Q3 deck?",
    date: "2026-07-13T14:00:00.000Z",
    body: "Hi — could you review the Q3 deck before our sync? A couple of slides need your take. Thanks!",
  }),
  gmailMessage({
    id: "g-priya-1",
    threadId: "th-priya",
    from: "Priya Nair <priya@acme.com>",
    to: ME,
    subject: "Board update — need your input today",
    date: "2026-07-15T15:30:00.000Z",
    body: "Can you send me the headline numbers for the board update today? Would like to include your section.",
  }),
  gmailMessage({
    id: "g-sam-1",
    threadId: "th-sam",
    from: "Sam Rivera <sam@partner.io>",
    to: ME,
    subject: "Contract draft",
    date: "2026-07-14T10:00:00.000Z",
    body: "Sharing the contract draft for the partnership. Let me know if the terms look right to you.",
  }),
  gmailMessage({
    id: "g-sam-2",
    threadId: "th-sam",
    from: "Sam Rivera <sam@partner.io>",
    to: ME,
    subject: "Re: Contract draft",
    date: "2026-07-15T11:00:00.000Z",
    body: "Following up on the contract draft — any thoughts before Friday?",
  }),
  gmailMessage({
    id: "g-fyi-1",
    threadId: "th-fyi",
    from: "Jordan Blake <jordan@random.com>",
    to: ME,
    subject: "Quick idea to share (FYI)",
    date: "2026-07-15T16:00:00.000Z",
    body: "Wanted to share an idea I had after our chat. No rush and nothing needed from you.",
  }),
  gmailMessage({
    id: "g-news-1",
    threadId: "th-news",
    from: "The Weekly <no-reply@weekly.example.com>",
    to: ME,
    subject: "Your Weekly Digest",
    date: "2026-07-15T06:00:00.000Z",
    body: "Here are this week's top stories and updates from around the web.",
  }),
  gmailMessage({
    id: "g-gh-1",
    threadId: "th-gh",
    from: "GitHub <notifications@github.com>",
    to: ME,
    subject: "[orion] Pull request merged",
    date: "2026-07-15T09:00:00.000Z",
    body: "Your pull request was merged into main. View it on GitHub.",
  }),
  gmailMessage({
    // The email mirror of the GitHub `gh-rev-128` ReviewRequested fact: same
    // change (acme/orion#128), arriving as an automated notification. It stays
    // SILENT under Gmail understanding (no-reply sender), while the GitHub Skill
    // emits ReviewRequested for the same underlying request. Two representations
    // of one occurrence — the concrete specimen cross-source correlation (#46)
    // must eventually collapse into a single Work Item.
    id: "g-gh-review-128",
    threadId: "th-gh-review-128",
    from: "GitHub <notifications@github.com>",
    to: ME,
    subject: "Review requested: Add retry to the event store",
    date: "2026-07-15T13:05:00.000Z",
    body: "Dana requested your review on acme/orion#128. https://github.com/acme/orion/pull/128",
  }),
];
