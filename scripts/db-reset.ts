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
for (const suffix of ["", "-wal", "-shm"]) {
  const file = `${dbPath}${suffix}`;
  if (existsSync(file)) {
    rmSync(file);
    console.log(`removed ${file}`);
    removed += 1;
  }
}

console.log(
  removed === 0
    ? `Nothing to reset (no log at ${dbPath}).`
    : "Event log reset. Next boot re-seeds from fixtures.",
);
