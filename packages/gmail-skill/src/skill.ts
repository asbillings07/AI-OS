import { makeEvent, EventTypes, type OrionRuntime, type MessageReceivedEvent } from "@orion/core";
import { FixtureGmailSource, type GmailSource } from "./source.js";
import { normalizeGmailMessage } from "./normalize.js";

export interface GmailSkillOptions {
  /** Defaults to captured fixtures (offline, key-free). */
  source?: GmailSource;
}

/**
 * The Gmail Skill (ADR-0010): the first integration. It observes messages from
 * a Source, normalizes them into domain MessageReceived events, and records
 * them on the runtime. It reaches the rest of Orion only through events — it
 * never touches Context, projections, or other Skills directly.
 *
 * Re-ingesting is safe: each event id is derived from the message id, so the
 * append-only store dedupes on replay/re-run (at-least-once, ADR-0008).
 */
export class GmailSkill {
  readonly #source: GmailSource;

  constructor(options: GmailSkillOptions = {}) {
    this.#source = options.source ?? new FixtureGmailSource();
  }

  get sourceName(): string {
    return this.#source.name;
  }

  /** Fetch, normalize, and record all messages as domain events. */
  async ingest(runtime: OrionRuntime): Promise<MessageReceivedEvent[]> {
    const rawMessages = await this.#source.fetchMessages();
    const events: MessageReceivedEvent[] = [];

    for (const raw of rawMessages) {
      const payload = normalizeGmailMessage(raw);
      const event = makeEvent({
        type: EventTypes.MessageReceived,
        source: "gmail-skill",
        payload,
        // Deterministic id from the message id -> idempotent ingestion.
        id: `gmail:${payload.messageId}`,
        occurredAt: payload.receivedAt,
      }) as MessageReceivedEvent;
      await runtime.record(event);
      events.push(event);
    }

    return events;
  }
}
