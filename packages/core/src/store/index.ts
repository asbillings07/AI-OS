import Database from "better-sqlite3";
import { deepFreeze, type EventEnvelope } from "../events/index.js";

/**
 * The append-only Event log (ADR-0009). Events are the single source of truth;
 * everything else is a rebuildable projection. The log is never updated or
 * deleted — only appended and read in order.
 */
export interface EventStore {
  /**
   * Append an event. Idempotent by event id (ADR-0008: at-least-once, dedupe).
   * Returns `true` if this call newly inserted the event, `false` if it was a
   * duplicate that was ignored. Callers use this to avoid re-delivering a fact
   * that is already on the log (storage idempotency is not delivery idempotency).
   */
  append(event: EventEnvelope): boolean;
  /** All events in the order they were recorded. */
  readAll(): EventEnvelope[];
  /** Number of events currently stored. */
  count(): number;
  close(): void;
}

interface EventRow {
  id: string;
  type: string;
  occurredAt: string;
  source: string;
  version: number;
  correlationId: string;
  causationId: string | null;
  payload: string;
}

/**
 * SQLite-backed event log. Boring on purpose: zero setup, single file (or
 * in-memory for tests), synchronous. The storage technology is reversible
 * behind this interface (ADR-0009); nothing in the domain depends on SQLite.
 *
 * Pass ":memory:" for tests, or a file path (e.g. ".data/orion.db") to persist.
 */
export class SqliteEventStore implements EventStore {
  readonly #db: Database.Database;
  readonly #insert: Database.Statement;
  readonly #selectAll: Database.Statement;
  readonly #countStmt: Database.Statement;

  constructor(location = ":memory:") {
    this.#db = new Database(location);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        id            TEXT NOT NULL UNIQUE,
        type          TEXT NOT NULL,
        occurredAt    TEXT NOT NULL,
        source        TEXT NOT NULL,
        version       INTEGER NOT NULL,
        correlationId TEXT NOT NULL,
        causationId   TEXT,
        payload       TEXT NOT NULL,
        recordedAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_correlation ON events (correlationId);
    `);
    // INSERT OR IGNORE makes re-delivery of the same event id a no-op.
    this.#insert = this.#db.prepare(`
      INSERT OR IGNORE INTO events
        (id, type, occurredAt, source, version, correlationId, causationId, payload)
      VALUES
        (@id, @type, @occurredAt, @source, @version, @correlationId, @causationId, @payload)
    `);
    this.#selectAll = this.#db.prepare(
      `SELECT id, type, occurredAt, source, version, correlationId, causationId, payload
       FROM events ORDER BY seq ASC`,
    );
    this.#countStmt = this.#db.prepare(`SELECT COUNT(*) AS n FROM events`);
  }

  append(event: EventEnvelope): boolean {
    // INSERT OR IGNORE reports 0 changed rows when the id already exists.
    const result = this.#insert.run({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      source: event.source,
      version: event.version,
      correlationId: event.correlationId,
      causationId: event.causationId,
      payload: JSON.stringify(event.payload),
    });
    return result.changes > 0;
  }

  readAll(): EventEnvelope[] {
    const rows = this.#selectAll.all() as EventRow[];
    return rows.map((row) =>
      deepFreeze({
        id: row.id,
        type: row.type,
        occurredAt: row.occurredAt,
        source: row.source,
        version: row.version,
        correlationId: row.correlationId,
        causationId: row.causationId,
        payload: JSON.parse(row.payload) as unknown,
      }),
    );
  }

  count(): number {
    const { n } = this.#countStmt.get() as { n: number };
    return n;
  }

  close(): void {
    this.#db.close();
  }
}
