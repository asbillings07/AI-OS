/**
 * Print the raw event log in order — the single source of truth (ADR-0009).
 * Read-only. Use it to see exactly what Orion knows, without touching the app.
 *
 * PRIVACY: payload previews can contain real source data (message content,
 * names, addresses) once live Gmail is connected. Treat this output as private —
 * don't paste it into public issues or logs.
 *
 *   npm run log:inspect
 */
import { existsSync } from "node:fs";
import { SqliteEventStore } from "@orion/core";
import { resolveDbPath } from "./_shared.js";

const PAYLOAD_PREVIEW = 140;

const dbPath = resolveDbPath();
if (!existsSync(dbPath)) {
  console.log(`No event log at ${dbPath}. Run: npm run bootstrap`);
  process.exit(0);
}

function previewPayload(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? String(payload);
  } catch {
    // An inspection tool must never abort mid-stream on an unserializable
    // payload (circular refs, BigInt, etc.) — degrade gracefully instead.
    serialized = "<unserializable payload>";
  }
  return serialized.length > PAYLOAD_PREVIEW
    ? `${serialized.slice(0, PAYLOAD_PREVIEW)}…`
    : serialized;
}

const store = new SqliteEventStore(dbPath);
try {
  const events = store.readAll();
  console.log(`${events.length} event(s) at ${dbPath}`);
  console.log("(payloads may contain private source data — do not share output publicly)\n");

  for (const [index, event] of events.entries()) {
    const preview = previewPayload(event.payload);
    console.log(
      `${String(index + 1).padStart(3)}. ${event.occurredAt}  ${event.type.padEnd(20)} src=${event.source}`,
    );
    console.log(`     id=${event.id}`);
    console.log(`     payload=${preview}`);
  }
} finally {
  // Always release the better-sqlite3 handle, even if readAll()/printing throws,
  // so the process exits promptly.
  store.close();
}
