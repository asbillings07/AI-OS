import type { ContextState } from "../understanding/context.js";
import { detectOpportunities } from "../opportunity/index.js";
import type { Opportunity } from "../opportunity/index.js";
import { detectWorkOpportunities } from "../understanding/work-opportunities.js";
import { estimateCapacity, type Capacity } from "../capacity/index.js";
import type { Signal } from "../understanding/signals.js";
import { subjectKey, type SubjectRef } from "../subject/index.js";
import { isVisible, attentionRevision, type AttentionState } from "../attention/index.js";
import { LogEvents, nullLogger, type Logger } from "../observability/index.js";
import {
  importanceContributionFor,
  NEUTRAL_IMPORTANCE,
  type ImportanceContribution,
  type PersonalImportanceState,
} from "../importance/index.js";

/**
 * How much Personal Importance can move `priority` off the other three inputs,
 * in either direction. Deliberately modest (#65): the signal is conservative by
 * construction (`importanceScore`), and this weight keeps a strong learned signal
 * from ever dominating intrinsic Opportunity/Urgency/Commitment.
 */
const IMPORTANCE_WEIGHT = 0.15;

/** No learned history anywhere -> every Subject's contribution is neutral. */
const NO_IMPORTANCE: PersonalImportanceState = { byOriginator: {} };

export type WorkItemBand = "needs_attention" | "can_wait";

/**
 * The ranking/explanation fields every Work Item carries, independent of its
 * Subject kind. The presentation fields (kind/subject/title/location/url) are
 * layered on per-Opportunity below so the discriminated relationship is preserved.
 */
interface WorkItemRanking {
  id: string;
  band: WorkItemBand;
  /** Final rank score, 0..1. */
  priority: number;
  // The four independent reasoning inputs, kept separate (never a product).
  opportunity: number;
  capacity: number;
  commitment: number;
  urgency: number;
  /**
   * The learned Personal Importance contribution (#65), `[0,1]`, `0.5` = neutral.
   * A fifth, optional input: unlike the four above it is not always present in
   * spirit (no originator -> neutral), and it is *learned*, not intrinsic to the
   * Opportunity or the moment.
   */
  importance: number;
  /** One-line deterministic explanation of why this is here. */
  reason: string;
  /** The full deterministic justification chain. */
  evidence: string[];
  /** The Events this Work Item ultimately traces back to (full provenance). */
  createdFromEventIds: string[];
  /** The current presentation revision the user is being shown (for actions). */
  attentionBasisEventIds: string[];
  /**
   * The acted/dismissed action-Event ids that produced `importance` (empty when
   * neutral/no originator). Distinct from `attentionBasisEventIds`, which is the
   * current presentation revision, not importance provenance (#65).
   */
  importanceEvidenceEventIds: string[];
  /**
   * Optimistic-concurrency token for {subject, attentionBasisEventIds}. Rendered
   * into the action form so the server can reject an action taken against a stale
   * revision (see attention/revision.ts).
   */
  attentionRevision: string;
  /** Advisory AI summary (optional; explanation never depends on it). */
  summary?: string;
  summaryConfidence?: number;
}

/**
 * A Work Item (ADR-0003): the canonical unit of "this matters," now source-neutral.
 * It is about a `subject` (a conversation, a review, an assignment, a check), not a
 * vendor. Its Explanation is *structured* — `reason` + `evidence` +
 * `createdFromEventIds` let Mission Control answer "Why is this here?" entirely from
 * deterministic reasoning (no AI). `summary` is the only AI-derived, advisory field.
 *
 * The type distributes over the Opportunity union so `kind` and `subject` stay
 * paired exactly as in Opportunity — a `RiskDetected` item structurally must carry
 * a check Subject, never a thread one.
 */
export type WorkItem = Opportunity extends infer O
  ? O extends Opportunity
    ? WorkItemRanking & Pick<O, "kind" | "subject" | "title" | "location" | "url">
    : never
  : never;

/**
 * Canonical, globally-unique Work Item id. Uses the full `subjectKey` (kind + id)
 * for every Subject so ids can never collide across kinds even when an opaque
 * external Subject id happens to resemble another kind's key. This id is a display/
 * lookup handle only — it is NOT the suppression identity (that is the Subject and
 * the attention basis; legacy Events reconstruct meaning from `threadId`).
 */
export function workItemId(subject: SubjectRef): string {
  return `wi-${subjectKey(subject)}`;
}

/** Deterministic, locale-independent string ordering (avoids localeCompare drift). */
function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function signalStrength(signals: readonly Signal[], kind: Signal["kind"]): number {
  return signals.find((signal) => signal.kind === kind)?.strength ?? 0;
}

/** Source-neutral lead line for each Opportunity kind. */
const LEAD_LINE: Record<Opportunity["kind"], string> = {
  ReplyNeeded: "You have not replied to this conversation.",
  ReviewNeeded: "A review is waiting on you.",
  AssignedActionNeeded: "You have been asked to take this on.",
  RiskDetected: "A check is failing on your work.",
};

/**
 * The evidence-specific, source-neutral importance sentence, or none when the
 * contribution is neutral/absent. Named after what the user actually did, never
 * "frequently"/"usually" (overclaims from a two-event threshold) and never a
 * source-specific noun like "messages" — the same wording fits a sender, a
 * reviewer, or an assigner.
 */
function importanceReasonFragment(contribution: ImportanceContribution | null): string | undefined {
  if (!contribution || contribution.score === NEUTRAL_IMPORTANCE) return undefined;
  const { originatorName } = contribution;
  return contribution.score > NEUTRAL_IMPORTANCE
    ? `You've acted on more work from ${originatorName} than you've dismissed.`
    : `You've dismissed more work from ${originatorName} than you've acted on.`;
}

/**
 * A deterministic, source-neutral one-line reason: the kind's lead line plus any
 * corroborating Signals that happen to be present, plus the learned importance
 * fragment when off-neutral. It consults Signal *kinds*, not sources, so an email
 * and a review are explained through the same vocabulary.
 */
function buildReason(
  kind: Opportunity["kind"],
  signals: readonly Signal[],
  contribution: ImportanceContribution | null,
): string {
  const parts = [LEAD_LINE[kind]];
  if (signalStrength(signals, "DirectQuestion") > 0) parts.push("It asks a direct question.");
  if (signalStrength(signals, "FromKnownPerson") > 0) parts.push("You've exchanged messages with this person.");
  if (signalStrength(signals, "Commitment") > 0) parts.push("You've taken this on.");
  if (signalStrength(signals, "Aging") > 0) parts.push("It has been waiting a while.");
  const importanceFragment = importanceReasonFragment(contribution);
  if (importanceFragment) parts.push(importanceFragment);
  return parts.join(" ");
}

/**
 * A deterministic, source-neutral ordering. Primary is priority; ties fall through
 * to the independent reasoning dimensions and finally to `subjectKey`, so the order
 * the detectors happened to run in can NEVER decide a tie (no email-first bias).
 */
export function compareWorkItems(a: WorkItem, b: WorkItem): number {
  return (
    b.priority - a.priority ||
    b.urgency - a.urgency ||
    b.commitment - a.commitment ||
    b.opportunity - a.opportunity ||
    b.importance - a.importance ||
    // Ordinal, not localeCompare: ranking must be identical on every machine
    // regardless of the host's default locale / ICU configuration.
    compareOrdinal(subjectKey(a.subject), subjectKey(b.subject))
  );
}

/**
 * Rank Opportunities into Work Items. The four intrinsic inputs are weighed as a
 * transparent weighted blend (NOT the product `o×c×m×u`, which would overclaim
 * precision, per #29). Capacity is deliberately kept OUT of the intrinsic score
 * and instead raises the attention bar: when the user cannot act well, fewer
 * items earn "needs attention", and they resurface when Capacity improves.
 *
 * `importanceBySubject` is the ONLY personalization input, and it is deliberately
 * plain data (score + evidence + a display name), keyed by `subjectKey` — never
 * Context or `PersonalImportanceState` itself (#65). This keeps `prioritize()`
 * pure and Context-independent: ranking never reopens Context, it only receives
 * an already-resolved numeric contribution per Subject.
 *
 * Source-neutral: it consumes any Opportunity kind and never reopens Context (the
 * Opportunity already carries its own presentation fields).
 */
export function prioritize(
  opportunities: readonly Opportunity[],
  capacity: Capacity,
  importanceBySubject: ReadonlyMap<string, ImportanceContribution> = new Map(),
): WorkItem[] {
  const attentionThreshold = 0.35 + (1 - capacity.level) * 0.35;

  const items = opportunities.map((opportunity): WorkItem => {
    const signals = opportunity.signals;
    // The `commitment` input blends explicit obligation (a Commitment Signal, e.g.
    // an assignment or requested review) with relationship-derived expectation
    // (FromKnownPerson). They are not the same thing — one is a duty, the other is
    // social weight — and may split into separate dimensions later; for now the
    // stronger of the two carries.
    const responsibilityStrength = Math.max(
      signalStrength(signals, "Commitment"),
      signalStrength(signals, "FromKnownPerson"),
    );
    const urgency = Math.max(
      signalStrength(signals, "Aging"),
      signalStrength(signals, "DirectQuestion") > 0 ? 0.4 : 0.2,
    );
    const contribution = importanceBySubject.get(subjectKey(opportunity.subject)) ?? null;
    const importance = contribution?.score ?? NEUTRAL_IMPORTANCE;
    // A bounded signed adjustment: neutral (0.5) contributes exactly 0, so a
    // Subject with no learned history ranks identically to today.
    const priority = Math.max(
      0,
      Math.min(
        1,
        0.45 * opportunity.value +
          0.25 * urgency +
          0.3 * responsibilityStrength +
          IMPORTANCE_WEIGHT * (importance - NEUTRAL_IMPORTANCE) * 2,
      ),
    );

    // The kind/subject pairing comes straight from one Opportunity, so it always
    // satisfies exactly one member of the WorkItem union; the cast tells the
    // compiler what it cannot correlate across the two fields on its own.
    return {
      id: workItemId(opportunity.subject),
      subject: opportunity.subject,
      kind: opportunity.kind,
      title: opportunity.title,
      location: opportunity.location,
      url: opportunity.url,
      band: priority >= attentionThreshold ? "needs_attention" : "can_wait",
      priority,
      opportunity: opportunity.value,
      capacity: capacity.level,
      commitment: responsibilityStrength,
      urgency,
      importance,
      reason: buildReason(opportunity.kind, signals, contribution),
      evidence: [...opportunity.evidence],
      createdFromEventIds: [...opportunity.createdFromEventIds],
      attentionBasisEventIds: [...opportunity.attentionBasisEventIds],
      attentionRevision: attentionRevision(opportunity.subject, opportunity.attentionBasisEventIds),
      importanceEvidenceEventIds: contribution ? [...contribution.evidenceEventIds] : [],
    } as WorkItem;
  });

  return items.sort(compareWorkItems);
}

export interface BuildWorkItemsOptions {
  context: ContextState;
  attention: AttentionState;
  /**
   * Learned Personal Importance evidence (#65). Optional and defaults to no
   * history (every Subject scores neutral) so existing callers that don't yet
   * care about personalization are unaffected.
   */
  importance?: PersonalImportanceState;
  now: string;
  logger?: Logger;
}

/**
 * The full deterministic prioritization pipeline: reality + the user's attention
 * + learned importance in, ranked Work Items out. Pure and reproducible given
 * `now` — no AI, no clock.
 *
 * Reality-derived Opportunities from every detector are combined, then the
 * Attention projection decides which are *visible* (the sole suppression stage).
 * Capacity is estimated from the current attention demand (visible count), so
 * dismissed/snoozed work stops weighing on the user while hidden. For each
 * visible Opportunity, `buildWorkItems` itself — the one place Context is read
 * for importance — calls `importanceContributionFor` to resolve the Context-
 * derived originator into a plain numeric contribution, then hands that plain
 * data off to `prioritize()`, which itself never sees Context.
 *
 * The optional logger only observes; it never changes the result and defaults to a
 * no-op. Trace names are computation-oriented (`opportunity.evaluated`/
 * `workitem.ranked`) because this runs on every read/rebuild, not on a recorded
 * state transition.
 */
export function buildWorkItems(options: BuildWorkItemsOptions): WorkItem[] {
  const { context, attention, now } = options;
  const importanceState = options.importance ?? NO_IMPORTANCE;
  const logger = options.logger ?? nullLogger;
  const tracing = logger !== nullLogger;

  const opportunities = [...detectOpportunities(context, now), ...detectWorkOpportunities(context, now)];
  const visible = opportunities.filter((opportunity) => isVisible(opportunity, attention, now));

  if (tracing) {
    for (const opportunity of visible) {
      logger.event(LogEvents.OpportunityEvaluated, {
        kind: opportunity.kind,
        subject: subjectKey(opportunity.subject),
        value: opportunity.value,
      });
    }
  }

  const importanceBySubject = new Map<string, ImportanceContribution>();
  for (const opportunity of visible) {
    const contribution = importanceContributionFor(opportunity.subject, context, importanceState);
    if (contribution) importanceBySubject.set(subjectKey(opportunity.subject), contribution);
  }

  const capacity = estimateCapacity(now, { activeWorkCount: visible.length });
  const items = prioritize(visible, capacity, importanceBySubject);

  if (tracing) {
    for (const item of items) {
      logger.event(LogEvents.WorkItemRanked, {
        id: item.id,
        band: item.band,
        priority: item.priority,
        importance: item.importance,
      });
    }
  }

  return items;
}
