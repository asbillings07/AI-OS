import type { EventType } from "../domain/index.js";

/**
 * How a Skill declares itself to the platform (ADR-0010). This is extension
 * topology, not domain vocabulary, so it lives outside `domain/`: it says who a
 * Skill is and which Events it produces/consumes, so the platform can reason
 * about wiring without hard-coding any particular Skill.
 *
 * `produces`/`consumes` are typed as `EventType` because core owns the domain
 * vocabulary today; declaring a manifest `as const satisfies SkillManifest`
 * turns a misspelled event name into a compile error without widening to
 * `string[]`. (If externally authored Skills ever define their own event types,
 * that will need a separate schema-registration model.)
 */
export interface SkillManifest {
  readonly id: string;
  /** The `source` label this Skill stamps on every Event it emits. */
  readonly source: string;
  readonly produces: readonly EventType[];
  readonly consumes: readonly EventType[];
}
