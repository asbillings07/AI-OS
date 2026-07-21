/**
 * Wipe the local event log. Safe because the log is the source of truth for a
 * *local dev* database only — the next `npm run bootstrap` (or app boot) re-seeds
 * from fixtures. Removes the SQLite file and its WAL/SHM sidecars.
 *
 *   npm run db:reset
 */
import { existsSync, rmSync } from "node:fs";
import { resolveDbPath } from "./_shared.js";

const dbPath = resolveDbPath();
let removed = 0;
let failed = 0;
for (const suffix of ["", "-wal", "-shm"]) {
  const file = `${dbPath}${suffix}`;
  if (!existsSync(file)) {
    continue;
  }
  try {
    rmSync(file);
    console.log(`removed ${file}`);
    removed += 1;
  } catch (error) {
    // Keep going so one locked/permission-denied sidecar doesn't leave the
    // rest behind. Surface the error and fail the exit code at the end.
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed to remove ${file}: ${message}`);
  }
}

console.log(
  removed === 0 && failed === 0
    ? `Nothing to reset (no log at ${dbPath}).`
    : "Event log reset. Next boot re-seeds from fixtures.",
);

if (failed > 0) {
  console.error(`${failed} file(s) could not be removed — reset incomplete.`);
  process.exit(1);
}
