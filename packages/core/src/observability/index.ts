/**
 * Just enough light inside the machine that debugging doesn't require
 * archaeology. This is NOT production telemetry — it's a structured trace of the
 * decision loop's key moments, off by default and free when disabled.
 *
 * Design constraints:
 *  - Framework-free: one interface, a null implementation, and a JSON-lines
 *    console implementation. No logging library, no transport.
 *  - Silent by default with negligible overhead: tests and the deterministic
 *    slice stay quiet unless ORION_LOG is set, so log output never becomes part
 *    of any assertion, and the disabled logger does no I/O.
 *  - A cross-cutting concern the domain shouldn't know about: pure functions
 *    accept a Logger only as an optional, defaulted argument and never require it.
 */

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  /** Emit one structured event. Implementations must never throw. */
  event(name: string, fields?: LogFields): void;
}

/**
 * The canonical moments in the decision loop worth tracing.
 *
 * Naming distinguishes *history* from *computation*. `event.recorded` describes a
 * durable fact appended to the log (persistence, not delivery). By contrast the
 * read pipeline runs on every render/rebuild, so its trace names are
 * computation-oriented (`opportunity.evaluated`, `workitem.ranked`) — they are
 * NOT the reserved domain event `OpportunityDetected`, which would imply a
 * recorded state transition.
 */
export const LogEvents = {
  EventRecorded: "event.recorded",
  EventDuplicate: "event.duplicate",
  ProjectionRebuilt: "projection.rebuilt",
  OpportunityEvaluated: "opportunity.evaluated",
  WorkItemRanked: "workitem.ranked",
  UserActionRecorded: "user.action.recorded",
  AiInvoked: "ai.invoked",
  GmailCredentialPersistFailed: "gmail.credential.persist_failed",
  // Live Gmail resilience. Retry traces a transient failure that will be retried;
  // Dropped traces a message abandoned after best-effort hydration. Neither ever
  // carries tokens, response bodies, snippets, or message content.
  GmailRequestRetried: "gmail.request.retried",
  GmailMessageDropped: "gmail.message.dropped",
} as const;

/** A logger that does nothing. The default everywhere, so logging is opt-in. */
export const nullLogger: Logger = { event() {} };

export interface ConsoleLoggerOptions {
  /** Force on/off. Defaults to reading ORION_LOG from the environment. */
  enabled?: boolean;
  /** Timestamp source (injectable for deterministic tests). */
  now?: () => string;
  /** Sink for a finished JSON line. Defaults to stderr. */
  write?: (line: string) => void;
  /** Environment to read the enable flag from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * ORION_LOG is truthy unless it's unset/empty or an explicit disable value.
 * This keeps `ORION_LOG=1`, `ORION_LOG=debug`, etc. all meaning "on".
 */
function enabledFromEnv(env: Record<string, string | undefined>): boolean {
  const value = env.ORION_LOG;
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off";
}

/**
 * A structured, JSON-lines logger. Writes one object per line to stderr so it
 * never mixes with program output on stdout and stays greppable/pipeable.
 * Returns {@link nullLogger} when disabled, so callers pay nothing for logging
 * they didn't turn on.
 */
export function createLogger(options: ConsoleLoggerOptions = {}): Logger {
  const env = options.env ?? (globalThis.process?.env ?? {});
  const enabled = options.enabled ?? enabledFromEnv(env);
  if (!enabled) return nullLogger;

  const now = options.now ?? (() => new Date().toISOString());
  const write =
    options.write ?? ((line: string) => void globalThis.process?.stderr?.write(`${line}\n`));

  return {
    event(name, fields) {
      try {
        // Canonical envelope fields come last so a caller's `fields` can never
        // overwrite the timestamp or event name on this shared chokepoint.
        write(JSON.stringify({ ...fields, t: now(), evt: name }));
      } catch {
        // A logger must never break the program it observes.
      }
    },
  };
}
