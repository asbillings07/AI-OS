import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file's location (scripts/ is one level down). */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the persistent event log lives. Defaults to the Mission Control app's
 * `.data/` so the CLI tools and the running app share one log; override with
 * ORION_DB_PATH. This is the source of truth (ADR-0009) — safe to delete and
 * rebuild, never to hand-edit.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORION_DB_PATH ?? path.join(repoRoot, "apps", "mission-control", ".data", "orion.db");
}
