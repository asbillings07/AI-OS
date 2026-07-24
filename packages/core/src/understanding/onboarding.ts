import type {
  BeliefCategory,
  BeliefTemporalScope,
  UserBeliefConfirmedEvent,
  UserBeliefCorrectedEvent,
  UserBeliefProposedEvent,
  UserBeliefRejectedEvent,
  UserOnboardingQuestionAskedEvent,
  UserOnboardingResetEvent,
  UserOnboardingRestartedEvent,
  UserOnboardingResumedEvent,
  UserOnboardingSkippedEvent,
  UserOnboardingStartedEvent,
  UserStatementProcessedEvent,
  UserStatementRecordedEvent,
  UserUnderstandingBaselineDeletedEvent,
  UserUnderstandingBaselineEstablishedEvent,
} from "../domain/index.js";
import { EventTypes } from "../domain/index.js";
import type { EventEnvelope } from "../events/index.js";
import { makeEvent } from "../events/index.js";
import type { Projection } from "../projection/index.js";

// ============================================================================
// 1. Extraction Port & Policy Gate Types
// ============================================================================

export interface ExtractionTurn {
  readonly question: string;
  readonly statement: string;
  readonly statementEnvelopeId: string;
}

export interface ExtractionRequest {
  readonly currentQuestion: string;
  readonly currentStatement: string;
  readonly currentStatementEnvelopeId: string;
  readonly priorTurns: readonly ExtractionTurn[];
  readonly eligibleCategories: ReadonlySet<BeliefCategory>;
}

export interface CandidateBeliefProposal {
  readonly subject: string;
  readonly claim: string;
  readonly category: BeliefCategory;
  readonly temporalScope: BeliefTemporalScope;
  readonly evidenceText: string;
  readonly supportingEnvelopeId?: string;
  readonly confidence: number;
}

export interface BeliefExtractor {
  extractCandidates(request: ExtractionRequest): Promise<readonly CandidateBeliefProposal[]>;
}

// ============================================================================
// 2. Two-Stage Deterministic Policy Gate
// ============================================================================

const SENSITIVE_TOPIC_PATTERN =
  /\b(health|medical|doctor|illness|diagnosis|treatment|medication|therapy|financial|income|salary|debt|mortgage|bank|tax|political|election|vote|party|religion|church|faith)\b/i;

const PROHIBITED_PATTERN =
  /\b(illegal|unlawful|explicit-pornography|hate-speech)\b/i;

const ALL_BELIEF_CATEGORIES: readonly BeliefCategory[] = [
  "values",
  "roles_and_relationships",
  "goals",
  "priorities",
  "constraints",
  "routines",
];

export interface PolicyGateOptions {
  readonly optInCategories?: ReadonlySet<BeliefCategory>;
  readonly grantedConsentCategories?: ReadonlySet<BeliefCategory>;
  readonly prohibitedCategories?: ReadonlySet<BeliefCategory>;
}

export class DeterministicPolicyGate {
  readonly #optInCategories: ReadonlySet<BeliefCategory>;
  readonly #grantedConsentCategories: ReadonlySet<BeliefCategory>;
  readonly #prohibitedCategories: ReadonlySet<BeliefCategory>;

  constructor(options: PolicyGateOptions = {}) {
    this.#optInCategories = options.optInCategories ?? new Set();
    this.#grantedConsentCategories = options.grantedConsentCategories ?? new Set();
    this.#prohibitedCategories = options.prohibitedCategories ?? new Set();
  }

  /**
   * Returns the set of categories eligible for extraction.
   * Excludes prohibited categories AND unconsented opt-in categories.
   */
  getEligibleCategories(): ReadonlySet<BeliefCategory> {
    const eligible = new Set<BeliefCategory>();
    for (const cat of ALL_BELIEF_CATEGORIES) {
      if (this.#prohibitedCategories.has(cat)) continue;
      if (this.#optInCategories.has(cat) && !this.#grantedConsentCategories.has(cat)) continue;
      eligible.add(cat);
    }
    return eligible;
  }

  /**
   * Pre-Extraction Gate: Checks whether statement text contains prohibited terms.
   */
  isExtractionAllowed(text: string): boolean {
    if (PROHIBITED_PATTERN.test(text)) {
      return false;
    }
    return true;
  }

  /**
   * Post-Extraction Validation Gate:
   * Validates explicit supporting envelope ID & evidence spans, drops unconsented opt-in categories or prohibited categories/content,
   * and assigns effective post-consent categoryPolicy ("allowed" or "confirmation_required").
   */
  validateCandidate(
    candidate: CandidateBeliefProposal,
    request: ExtractionRequest,
  ): {
    readonly valid: boolean;
    readonly categoryPolicy?: "allowed" | "confirmation_required";
    readonly sourceEventIds?: readonly string[];
  } {
    // Category pre-filtering check
    const eligible = this.getEligibleCategories();
    if (!eligible.has(candidate.category)) {
      return { valid: false };
    }

    // Prohibited content in claim or evidence
    if (
      PROHIBITED_PATTERN.test(candidate.claim) ||
      PROHIBITED_PATTERN.test(candidate.evidenceText)
    ) {
      return { valid: false };
    }

    const trimmedEvidence = candidate.evidenceText.trim();
    if (trimmedEvidence.length === 0) {
      return { valid: false };
    }

    // Explicit or implicit turn evidence validation
    let targetEnvelopeId: string | undefined;
    let targetStatementText: string | undefined;

    if (candidate.supportingEnvelopeId) {
      if (candidate.supportingEnvelopeId === request.currentStatementEnvelopeId) {
        targetEnvelopeId = request.currentStatementEnvelopeId;
        targetStatementText = request.currentStatement;
      } else {
        const turn = request.priorTurns.find(
          (t) => t.statementEnvelopeId === candidate.supportingEnvelopeId,
        );
        if (turn) {
          targetEnvelopeId = turn.statementEnvelopeId;
          targetStatementText = turn.statement;
        }
      }
    } else {
      // Default: find specific turn matching evidenceText
      if (request.currentStatement.includes(trimmedEvidence)) {
        targetEnvelopeId = request.currentStatementEnvelopeId;
        targetStatementText = request.currentStatement;
      } else {
        const turn = request.priorTurns.find((t) => t.statement.includes(trimmedEvidence));
        if (turn) {
          targetEnvelopeId = turn.statementEnvelopeId;
          targetStatementText = turn.statement;
        }
      }
    }

    if (
      !targetEnvelopeId ||
      !targetStatementText ||
      !targetStatementText.includes(trimmedEvidence)
    ) {
      return { valid: false };
    }

    // Check sensitive content keywords across claim, evidence, or target statement
    const isSensitive =
      SENSITIVE_TOPIC_PATTERN.test(candidate.claim) ||
      SENSITIVE_TOPIC_PATTERN.test(candidate.evidenceText) ||
      SENSITIVE_TOPIC_PATTERN.test(targetStatementText);

    // Effective post-consent policy is either confirmation_required or allowed
    const categoryPolicy: "allowed" | "confirmation_required" = isSensitive
      ? "confirmation_required"
      : "allowed";

    return {
      valid: true,
      categoryPolicy,
      sourceEventIds: [targetEnvelopeId],
    };
  }

  /**
   * Validates a proposed correction replacement against category policies and consent gates.
   */
  validateCorrection(
    correctedCategory: BeliefCategory,
    correctedClaim: string,
    rawCorrectionText: string,
  ): { readonly valid: boolean; readonly categoryPolicy?: "allowed" | "confirmation_required" } {
    const eligible = this.getEligibleCategories();
    if (!eligible.has(correctedCategory)) {
      return { valid: false };
    }

    if (
      PROHIBITED_PATTERN.test(correctedClaim) ||
      PROHIBITED_PATTERN.test(rawCorrectionText)
    ) {
      return { valid: false };
    }

    const isSensitive =
      SENSITIVE_TOPIC_PATTERN.test(correctedClaim) ||
      SENSITIVE_TOPIC_PATTERN.test(rawCorrectionText);

    const categoryPolicy: "allowed" | "confirmation_required" = isSensitive
      ? "confirmation_required"
      : "allowed";

    return {
      valid: true,
      categoryPolicy,
    };
  }
}

// ============================================================================
// Helper: Minimal Evidence Provenance (sourceEventIds)
// ============================================================================

export function determineSourceEventIds(
  evidenceText: string,
  request: ExtractionRequest,
): readonly string[] {
  const trimmed = evidenceText.trim();
  if (request.currentStatement.includes(trimmed)) {
    return [request.currentStatementEnvelopeId];
  }
  for (const turn of request.priorTurns) {
    if (turn.statement.includes(trimmed)) {
      return [turn.statementEnvelopeId];
    }
  }
  return [request.currentStatementEnvelopeId];
}

// ============================================================================
// 3. Scripted Belief Extractor (for deterministic test fixtures and replay)
// ============================================================================

export class ScriptedBeliefExtractor implements BeliefExtractor {
  readonly #rules: ReadonlyArray<{
    readonly pattern: RegExp;
    readonly proposals: readonly CandidateBeliefProposal[];
  }>;

  constructor(
    rules: ReadonlyArray<{
      readonly pattern: RegExp;
      readonly proposals: readonly CandidateBeliefProposal[];
    }> = [],
  ) {
    this.#rules = rules;
  }

  async extractCandidates(request: ExtractionRequest): Promise<readonly CandidateBeliefProposal[]> {
    const text = request.currentStatement;
    const candidates: CandidateBeliefProposal[] = [];

    for (const rule of this.#rules) {
      if (rule.pattern.test(text)) {
        for (const prop of rule.proposals) {
          if (request.eligibleCategories.has(prop.category)) {
            candidates.push(prop);
          }
        }
      }
    }

    return candidates;
  }
}

// ============================================================================
// 4. Onboarding Projection & State Types
// ============================================================================

export interface OnboardingBeliefState {
  readonly beliefId: string;
  readonly statementEnvelopeId: string;
  readonly subject: string;
  readonly claim: string;
  readonly category: BeliefCategory;
  readonly temporalScope: BeliefTemporalScope;
  readonly evidenceText: string;
  readonly origin: "user_statement";
  readonly derivation: "ai_assisted_inference" | "declared_directly";
  readonly verification: "unconfirmed" | "user_confirmed";
  readonly sourceEventIds: readonly string[];
  readonly confidence: number;
  readonly categoryPolicy: "allowed" | "confirmation_required" | "opt_in";
  readonly status: "proposed" | "confirmed" | "corrected" | "rejected" | "superseded";
  readonly correctedFromBeliefId?: string;
  readonly rawCorrectionText?: string;
}

export interface OnboardingTurnState {
  readonly questionId: string;
  readonly questionText: string;
  readonly questionKind: "opening" | "follow_up";
  readonly ordinal: number;
  readonly statementId?: string;
  readonly statementEnvelopeId?: string;
  readonly rawStatementText?: string;
  readonly isStatementProcessed?: boolean;
}

export interface OnboardingSessionState {
  readonly sessionId: string;
  readonly status: "active" | "paused" | "completed" | "abandoned";
  readonly turns: readonly OnboardingTurnState[];
  readonly beliefs: ReadonlyMap<string, OnboardingBeliefState>;
  readonly isBaselineEstablished: boolean;
  readonly baselineConfirmedBeliefIds?: readonly string[];
  readonly baselineSummary?: readonly string[];
  readonly isBaselineDeleted: boolean;
  readonly restartedFromSessionId?: string;
  readonly skipCount: number;
  readonly resumeCount: number;
  readonly resetCount: number;
}

export interface OnboardingState {
  readonly sessions: ReadonlyMap<string, OnboardingSessionState>;
  readonly activeSessionId?: string;
}

export const initialOnboardingState: OnboardingState = {
  sessions: new Map(),
};

function foldStarted(state: OnboardingState, event: UserOnboardingStartedEvent): OnboardingState {
  const { sessionId } = event.payload;
  const existing = state.sessions.get(sessionId);
  if (existing) return state;

  const newSession: OnboardingSessionState = {
    sessionId,
    status: "active",
    turns: [],
    beliefs: new Map(),
    isBaselineEstablished: false,
    isBaselineDeleted: false,
    skipCount: 0,
    resumeCount: 0,
    resetCount: 0,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, newSession);
  return { ...state, sessions, activeSessionId: sessionId };
}

function foldQuestionAsked(
  state: OnboardingState,
  event: UserOnboardingQuestionAskedEvent,
): OnboardingState {
  const { sessionId, questionId, text, kind, ordinal } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session) return state;

  // Check duplicate question
  if (session.turns.some((t) => t.questionId === questionId)) return state;

  const newTurn: OnboardingTurnState = {
    questionId,
    questionText: text,
    questionKind: kind,
    ordinal,
  };

  const updatedSession: OnboardingSessionState = {
    ...session,
    status: "active",
    turns: [...session.turns, newTurn],
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldStatementRecorded(
  state: OnboardingState,
  event: UserStatementRecordedEvent,
): OnboardingState {
  const { sessionId, questionId, statementId, rawText } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session) return state;

  const updatedTurns = session.turns.map((turn) => {
    if (turn.questionId === questionId) {
      return {
        ...turn,
        statementId,
        statementEnvelopeId: event.id,
        rawStatementText: rawText,
      };
    }
    return turn;
  });

  const updatedSession: OnboardingSessionState = {
    ...session,
    turns: updatedTurns,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldStatementProcessed(
  state: OnboardingState,
  event: UserStatementProcessedEvent,
): OnboardingState {
  const { sessionId, questionId } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session) return state;

  const updatedTurns = session.turns.map((turn) => {
    if (turn.questionId === questionId) {
      return {
        ...turn,
        isStatementProcessed: true,
      };
    }
    return turn;
  });

  const updatedSession: OnboardingSessionState = {
    ...session,
    turns: updatedTurns,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldBeliefProposed(
  state: OnboardingState,
  event: UserBeliefProposedEvent,
): OnboardingState {
  const {
    sessionId,
    beliefId,
    statementEnvelopeId,
    subject,
    claim,
    category,
    temporalScope,
    evidenceText,
    sourceEventIds,
    confidence,
    categoryPolicy,
  } = event.payload;

  const session = state.sessions.get(sessionId);
  if (!session) return state;

  if (session.beliefs.has(beliefId)) return state;

  const newBelief: OnboardingBeliefState = {
    beliefId,
    statementEnvelopeId,
    subject,
    claim,
    category,
    temporalScope,
    evidenceText,
    origin: "user_statement",
    derivation: "ai_assisted_inference",
    verification: "unconfirmed",
    sourceEventIds,
    confidence,
    categoryPolicy,
    status: "proposed",
  };

  const beliefs = new Map(session.beliefs);
  beliefs.set(beliefId, newBelief);

  const updatedSession: OnboardingSessionState = {
    ...session,
    beliefs,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldBeliefConfirmed(
  state: OnboardingState,
  event: UserBeliefConfirmedEvent,
): OnboardingState {
  const { sessionId, beliefId } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session || session.isBaselineEstablished) return state;

  const existing = session.beliefs.get(beliefId);
  if (!existing || existing.status !== "proposed") return state;

  const updatedBelief: OnboardingBeliefState = {
    ...existing,
    verification: "user_confirmed",
    status: "confirmed",
  };

  const beliefs = new Map(session.beliefs);
  beliefs.set(beliefId, updatedBelief);

  const updatedSession: OnboardingSessionState = {
    ...session,
    beliefs,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldBeliefCorrected(
  state: OnboardingState,
  event: UserBeliefCorrectedEvent,
): OnboardingState {
  const {
    sessionId,
    oldBeliefId,
    newBeliefId,
    rawCorrectionText,
    correctedClaim,
    correctedSubject,
    correctedCategory,
    correctedTemporalScope,
    categoryPolicy,
  } = event.payload;

  const session = state.sessions.get(sessionId);
  if (!session || session.isBaselineEstablished) return state;

  const oldBelief = session.beliefs.get(oldBeliefId);
  if (!oldBelief || (oldBelief.status !== "proposed" && oldBelief.status !== "confirmed")) {
    return state;
  }

  const updatedOld: OnboardingBeliefState = {
    ...oldBelief,
    status: "superseded",
  };

  const replacement: OnboardingBeliefState = {
    beliefId: newBeliefId,
    statementEnvelopeId: event.id,
    subject: correctedSubject,
    claim: correctedClaim,
    category: correctedCategory,
    temporalScope: correctedTemporalScope,
    evidenceText: rawCorrectionText,
    origin: "user_statement",
    derivation: "declared_directly",
    verification: "user_confirmed",
    sourceEventIds: [event.id], // Correction event is sole supporting evidence!
    confidence: 1.0,
    categoryPolicy: categoryPolicy ?? "allowed",
    status: "confirmed",
    correctedFromBeliefId: oldBeliefId,
    rawCorrectionText,
  };

  const beliefs = new Map(session.beliefs);
  beliefs.set(oldBeliefId, updatedOld);
  beliefs.set(newBeliefId, replacement);

  const updatedSession: OnboardingSessionState = {
    ...session,
    beliefs,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldBeliefRejected(
  state: OnboardingState,
  event: UserBeliefRejectedEvent,
): OnboardingState {
  const { sessionId, beliefId } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session || session.isBaselineEstablished) return state;

  const existing = session.beliefs.get(beliefId);
  if (!existing || existing.status !== "proposed") return state;

  const updated: OnboardingBeliefState = {
    ...existing,
    status: "rejected",
  };

  const beliefs = new Map(session.beliefs);
  beliefs.set(beliefId, updated);

  const updatedSession: OnboardingSessionState = {
    ...session,
    beliefs,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldBaselineEstablished(
  state: OnboardingState,
  event: UserUnderstandingBaselineEstablishedEvent,
): OnboardingState {
  const { sessionId, confirmedBeliefIds, summary } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session || session.status !== "active" || session.isBaselineEstablished) return state;

  const updatedSession: OnboardingSessionState = {
    ...session,
    status: "completed",
    isBaselineEstablished: true,
    baselineConfirmedBeliefIds: confirmedBeliefIds,
    baselineSummary: summary,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldSkipped(state: OnboardingState, event: UserOnboardingSkippedEvent): OnboardingState {
  const { sessionId } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session) return state;

  const updatedSession: OnboardingSessionState = {
    ...session,
    status: "paused",
    skipCount: session.skipCount + 1,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldResumed(state: OnboardingState, event: UserOnboardingResumedEvent): OnboardingState {
  const { sessionId } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session) return state;

  const updatedSession: OnboardingSessionState = {
    ...session,
    status: "active",
    resumeCount: session.resumeCount + 1,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions, activeSessionId: sessionId };
}

function foldRestarted(
  state: OnboardingState,
  event: UserOnboardingRestartedEvent,
): OnboardingState {
  const { oldSessionId, newSessionId } = event.payload;
  const oldSession = state.sessions.get(oldSessionId);

  const sessions = new Map(state.sessions);

  if (oldSession) {
    sessions.set(oldSessionId, {
      ...oldSession,
      status: "abandoned",
    });
  }

  const newSession: OnboardingSessionState = {
    sessionId: newSessionId,
    restartedFromSessionId: oldSessionId,
    status: "active",
    turns: [],
    beliefs: new Map(),
    isBaselineEstablished: false,
    isBaselineDeleted: false,
    skipCount: 0,
    resumeCount: 0,
    resetCount: 0,
  };

  sessions.set(newSessionId, newSession);
  return { ...state, sessions, activeSessionId: newSessionId };
}

function foldReset(state: OnboardingState, event: UserOnboardingResetEvent): OnboardingState {
  const { sessionId } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session || session.status === "completed") return state;

  const updatedSession: OnboardingSessionState = {
    ...session,
    turns: [],
    beliefs: new Map(),
    resetCount: session.resetCount + 1,
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

function foldBaselineDeleted(
  state: OnboardingState,
  event: UserUnderstandingBaselineDeletedEvent,
): OnboardingState {
  const { sessionId } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session) return state;

  const updatedSession: OnboardingSessionState = {
    ...session,
    isBaselineEstablished: false,
    isBaselineDeleted: true,
    baselineConfirmedBeliefIds: undefined,
    baselineSummary: undefined,
    beliefs: new Map(),
  };

  const sessions = new Map(state.sessions);
  sessions.set(sessionId, updatedSession);
  return { ...state, sessions };
}

export const onboardingProjection: Projection<OnboardingState> = {
  name: "onboarding",
  init(): OnboardingState {
    return initialOnboardingState;
  },
  apply(state: OnboardingState, event: EventEnvelope): OnboardingState {
    switch (event.type) {
      case EventTypes.UserOnboardingStarted:
        return foldStarted(state, event as UserOnboardingStartedEvent);
      case EventTypes.UserOnboardingQuestionAsked:
        return foldQuestionAsked(state, event as UserOnboardingQuestionAskedEvent);
      case EventTypes.UserStatementRecorded:
        return foldStatementRecorded(state, event as UserStatementRecordedEvent);
      case EventTypes.UserStatementProcessed:
        return foldStatementProcessed(state, event as UserStatementProcessedEvent);
      case EventTypes.UserBeliefProposed:
        return foldBeliefProposed(state, event as UserBeliefProposedEvent);
      case EventTypes.UserBeliefConfirmed:
        return foldBeliefConfirmed(state, event as UserBeliefConfirmedEvent);
      case EventTypes.UserBeliefCorrected:
        return foldBeliefCorrected(state, event as UserBeliefCorrectedEvent);
      case EventTypes.UserBeliefRejected:
        return foldBeliefRejected(state, event as UserBeliefRejectedEvent);
      case EventTypes.UserUnderstandingBaselineEstablished:
        return foldBaselineEstablished(
          state,
          event as UserUnderstandingBaselineEstablishedEvent,
        );
      case EventTypes.UserOnboardingSkipped:
        return foldSkipped(state, event as UserOnboardingSkippedEvent);
      case EventTypes.UserOnboardingResumed:
        return foldResumed(state, event as UserOnboardingResumedEvent);
      case EventTypes.UserOnboardingRestarted:
        return foldRestarted(state, event as UserOnboardingRestartedEvent);
      case EventTypes.UserOnboardingReset:
        return foldReset(state, event as UserOnboardingResetEvent);
      case EventTypes.UserUnderstandingBaselineDeleted:
        return foldBaselineDeleted(
          state,
          event as UserUnderstandingBaselineDeletedEvent,
        );
      default:
        return state;
    }
  },
};

// ============================================================================
// 5. Onboarding Summary Formatter
// ============================================================================

export function formatBaselineSummary(
  beliefs: readonly OnboardingBeliefState[],
): readonly string[] {
  const confirmed = beliefs.filter((b) => b.status === "confirmed");
  return confirmed.map((b) => {
    switch (b.category) {
      case "values":
        return `${b.claim} is central right now.`;
      case "goals":
        return `You are focused on ${b.claim.toLowerCase()}.`;
      case "roles_and_relationships":
        return `Your role and key relationship focus: ${b.claim}.`;
      case "priorities":
        return `${b.claim} is a current working priority.`;
      case "constraints":
        return `Operational constraint: ${b.claim}.`;
      case "routines":
        return `Behavioral routine: ${b.claim}.`;
      default:
        return `${b.claim}.`;
    }
  });
}

// ============================================================================
// 6. Onboarding Engine Application Service
// ============================================================================

export interface OnboardingEngineOptions {
  readonly runtime: {
    readonly recordExclusive: (build: () => EventEnvelope | null) => Promise<boolean>;
  };
  readonly extractor: BeliefExtractor;
  readonly policyGate?: DeterministicPolicyGate;
  readonly getProjectionState: () => OnboardingState;
}

export class OnboardingEngine {
  readonly #runtime: {
    readonly recordExclusive: (build: () => EventEnvelope | null) => Promise<boolean>;
  };
  readonly #extractor: BeliefExtractor;
  readonly #policyGate: DeterministicPolicyGate;
  readonly #getProjectionState: () => OnboardingState;

  constructor(options: OnboardingEngineOptions) {
    this.#runtime = options.runtime;
    this.#extractor = options.extractor;
    this.#policyGate = options.policyGate ?? new DeterministicPolicyGate();
    this.#getProjectionState = options.getProjectionState;
  }

  async startSession(options: {
    readonly sessionId?: string;
    readonly openingQuestionText?: string;
    readonly now?: string;
  } = {}): Promise<{ readonly sessionId: string; readonly questionId: string; readonly questionText: string }> {
    const sessionId = options.sessionId ?? `session_${Date.now()}`;
    const questionText = options.openingQuestionText ?? "What is important to you?";
    const questionId = `q_${sessionId}_1`;
    const occurredAt = options.now ?? new Date().toISOString();

    const currentState = this.#getProjectionState();
    const existingSession = currentState.sessions.get(sessionId);
    if (existingSession && existingSession.turns.length > 0) {
      const firstTurn = existingSession.turns[0]!;
      return {
        sessionId,
        questionId: firstTurn.questionId,
        questionText: firstTurn.questionText,
      };
    }

    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      if (state.sessions.has(sessionId)) return null;

      const startedEvent = makeEvent({
        id: `evt_start_${sessionId}`,
        type: EventTypes.UserOnboardingStarted,
        source: "orion",
        occurredAt,
        payload: { sessionId, startedAt: occurredAt },
      });
      return startedEvent;
    });

    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || session.turns.some((t) => t.questionId === questionId)) return null;

      const askedEvent = makeEvent({
        id: `evt_ask_${questionId}`,
        type: EventTypes.UserOnboardingQuestionAsked,
        source: "orion",
        occurredAt,
        payload: {
          questionId,
          sessionId,
          kind: "opening",
          text: questionText,
          ordinal: 1,
          mechanismVersion: "v0.1",
          askedAt: occurredAt,
        },
      });
      return askedEvent;
    });

    return { sessionId, questionId, questionText };
  }

  async recordStatement(options: {
    readonly sessionId: string;
    readonly questionId: string;
    readonly rawText: string;
    readonly now?: string;
  }): Promise<{
    readonly statementId: string;
    readonly statementEnvelopeId: string;
    readonly proposedBeliefs: readonly OnboardingBeliefState[];
  }> {
    const { sessionId, questionId, rawText } = options;
    const occurredAt = options.now ?? new Date().toISOString();

    const initialState = this.#getProjectionState();
    const initialSession = initialState.sessions.get(sessionId);

    if (!initialSession || initialSession.status !== "active" || initialSession.isBaselineEstablished) {
      throw new Error(`Cannot record statement: session ${sessionId} is not active or baseline is established`);
    }

    const initialTurn = initialSession.turns.find((t) => t.questionId === questionId);
    if (!initialTurn) {
      throw new Error(`Question ${questionId} not found in session ${sessionId}`);
    }

    // Step 1: Record UserStatementRecorded if statement event not yet recorded
    if (!initialTurn.statementId) {
      const statementId = `stmt_${sessionId}_${questionId}`;
      const statementEnvelopeId = `evt_stmt_${statementId}`;

      await this.#runtime.recordExclusive(() => {
        const state = this.#getProjectionState();
        const session = state.sessions.get(sessionId);
        if (!session || session.status !== "active") return null;

        const currentTurn = session.turns.find((t) => t.questionId === questionId);
        if (!currentTurn || currentTurn.statementId) return null;

        const stmtEvent = makeEvent({
          id: statementEnvelopeId,
          type: EventTypes.UserStatementRecorded,
          source: "orion",
          occurredAt,
          payload: {
            statementId,
            sessionId,
            questionId,
            rawText,
            recordedAt: occurredAt,
          },
        });
        return stmtEvent;
      });
    }

    // Step 2: ALWAYS re-read projection to get PERSISTED statement text and envelope ID
    // (This prevents concurrency races and guarantees extraction uses recorded text!)
    const stateAfterStmt = this.#getProjectionState();
    const sessionAfterStmt = stateAfterStmt.sessions.get(sessionId)!;
    const currentTurn = sessionAfterStmt.turns.find((t) => t.questionId === questionId)!;

    const statementId = currentTurn.statementId!;
    const statementEnvelopeId = currentTurn.statementEnvelopeId!;
    const persistedRawText = currentTurn.rawStatementText!;

    // Step 3: Check completion boundary
    if (currentTurn.isStatementProcessed) {
      const existingProposals = Array.from(sessionAfterStmt.beliefs.values()).filter(
        (b) => b.statementEnvelopeId === statementEnvelopeId,
      );
      return {
        statementId,
        statementEnvelopeId,
        proposedBeliefs: existingProposals,
      };
    }

    // Step 4: Resume or execute candidate proposal extraction
    const priorTurns: ExtractionTurn[] = sessionAfterStmt.turns
      .filter((t) => t.questionId !== questionId && t.statementEnvelopeId && t.rawStatementText)
      .map((t) => ({
        question: t.questionText,
        statement: t.rawStatementText!,
        statementEnvelopeId: t.statementEnvelopeId!,
      }));

    const eligibleCategories = this.#policyGate.getEligibleCategories();

    const extractionRequest: ExtractionRequest = {
      currentQuestion: currentTurn.questionText,
      currentStatement: persistedRawText,
      currentStatementEnvelopeId: statementEnvelopeId,
      priorTurns,
      eligibleCategories,
    };

    const recordedBeliefIds: string[] = [];

    // Pre-extraction statement check
    if (this.#policyGate.isExtractionAllowed(persistedRawText)) {
      const candidates = await this.#extractor.extractCandidates(extractionRequest);

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        const validation = this.#policyGate.validateCandidate(candidate, extractionRequest);

        if (!validation.valid || !validation.categoryPolicy || !validation.sourceEventIds) {
          continue; // Dropped invalid or unconsented candidate
        }

        const candidateHash = candidate.claim.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30);
        const beliefId = `belief_${sessionId}_${statementId}_${i}_${candidateHash}`;

        await this.#runtime.recordExclusive(() => {
          const s = this.#getProjectionState();
          const sess = s.sessions.get(sessionId);
          if (!sess || sess.beliefs.has(beliefId)) return null;

          const proposedEvent = makeEvent({
            id: `evt_prop_${beliefId}`,
            type: EventTypes.UserBeliefProposed,
            source: "orion",
            occurredAt,
            payload: {
              beliefId,
              sessionId,
              statementEnvelopeId,
              subject: candidate.subject,
              claim: candidate.claim,
              category: candidate.category,
              temporalScope: candidate.temporalScope,
              evidenceText: candidate.evidenceText,
              origin: "user_statement",
              derivation: "ai_assisted_inference",
              verification: "unconfirmed",
              sourceEventIds: validation.sourceEventIds!,
              confidence: candidate.confidence,
              categoryPolicy: validation.categoryPolicy,
              inferenceMechanism: "v0.1",
              promptSchemaVersion: "v0.1",
              validFrom: occurredAt,
              proposedAt: occurredAt,
            },
          });
          return proposedEvent;
        });

        recordedBeliefIds.push(beliefId);
      }
    }

    // Step 5: Record completion boundary event
    await this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess) return null;

      const t = sess.turns.find((turn) => turn.questionId === questionId);
      if (!t || t.isStatementProcessed) return null;

      const processedEvent = makeEvent({
        id: `evt_stmt_proc_${statementId}`,
        type: EventTypes.UserStatementProcessed,
        source: "orion",
        occurredAt,
        payload: {
          statementId,
          statementEnvelopeId,
          sessionId,
          questionId,
          proposedBeliefIds: recordedBeliefIds,
          processedAt: occurredAt,
        },
      });
      return processedEvent;
    });

    const finalState = this.#getProjectionState();
    const finalSession = finalState.sessions.get(sessionId)!;
    const updatedProposals = Array.from(finalSession.beliefs.values()).filter(
      (b) => b.statementEnvelopeId === statementEnvelopeId,
    );

    return {
      statementId,
      statementEnvelopeId,
      proposedBeliefs: updatedProposals,
    };
  }

  async askFollowUp(options: {
    readonly sessionId: string;
    readonly questionText: string;
    readonly now?: string;
  }): Promise<{ readonly questionId: string; readonly questionText: string }> {
    const { sessionId, questionText } = options;
    const occurredAt = options.now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);
    if (!session || session.status !== "active" || session.isBaselineEstablished) {
      throw new Error(`Cannot ask follow-up: session ${sessionId} is not active or baseline is established`);
    }

    // Single pending question rule: if ANY question is unanswered, return it!
    const pendingTurn = session.turns.find((t) => !t.statementId);
    if (pendingTurn) {
      return { questionId: pendingTurn.questionId, questionText: pendingTurn.questionText };
    }

    const ordinal = session.turns.length + 1;
    if (ordinal > 4) {
      throw new Error(`Follow-up limit exceeded: maximum 3 follow-up questions allowed`);
    }

    const questionId = `q_${sessionId}_${ordinal}`;

    await this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.turns.some((t) => t.questionId === questionId)) return null;

      const askedEvent = makeEvent({
        id: `evt_ask_${questionId}`,
        type: EventTypes.UserOnboardingQuestionAsked,
        source: "orion",
        occurredAt,
        payload: {
          questionId,
          sessionId,
          kind: "follow_up",
          text: questionText,
          ordinal,
          mechanismVersion: "v0.1",
          askedAt: occurredAt,
        },
      });
      return askedEvent;
    });

    return { questionId, questionText };
  }

  async handleUncertainty(options: {
    readonly sessionId: string;
    readonly questionId: string;
    readonly rawText: string;
    readonly now?: string;
  }): Promise<{ readonly statementId: string }> {
    const { sessionId, questionId, rawText } = options;
    const statementId = `stmt_${sessionId}_${questionId}`;
    const occurredAt = options.now ?? new Date().toISOString();

    const initialState = this.#getProjectionState();
    const initialSession = initialState.sessions.get(sessionId);
    if (!initialSession || initialSession.status !== "active" || initialSession.isBaselineEstablished) {
      throw new Error(`Cannot handle uncertainty: session ${sessionId} is not active or baseline established`);
    }

    const turn = initialSession.turns.find((t) => t.questionId === questionId);
    if (!turn) throw new Error(`Question ${questionId} not found in session ${sessionId}`);

    if (turn.statementId) {
      return { statementId: turn.statementId };
    }

    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || session.status !== "active") return null;

      const t = session.turns.find((turnItem) => turnItem.questionId === questionId);
      if (!t || t.statementId) return null;

      const stmtEvent = makeEvent({
        id: `evt_stmt_${statementId}`,
        type: EventTypes.UserStatementRecorded,
        source: "orion",
        occurredAt,
        payload: {
          statementId,
          sessionId,
          questionId,
          rawText,
          recordedAt: occurredAt,
        },
      });
      return stmtEvent;
    });

    // Move session to paused state when uncertainty is stated
    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || session.status !== "active") return null;

      const skipEvent = makeEvent({
        id: `evt_skip_${sessionId}_${session.skipCount + 1}`,
        type: EventTypes.UserOnboardingSkipped,
        source: "orion",
        occurredAt,
        payload: { sessionId, skippedAt: occurredAt },
      });
      return skipEvent;
    });

    return { statementId };
  }

  async confirmBelief(options: {
    readonly sessionId: string;
    readonly beliefId: string;
    readonly now?: string;
  }): Promise<boolean> {
    const { sessionId, beliefId } = options;
    const occurredAt = options.now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);
    if (!session || session.status !== "active" || session.isBaselineEstablished) {
      return false;
    }

    const belief = session.beliefs.get(beliefId);
    if (!belief) return false;
    if (belief.status === "confirmed") return true; // Idempotent return
    if (belief.status !== "proposed") return false; // Cannot confirm rejected/superseded

    return this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.status !== "active" || sess.isBaselineEstablished) return null;

      const b = sess.beliefs.get(beliefId);
      if (!b || b.status !== "proposed") return null;

      const confirmEvent = makeEvent({
        id: `evt_conf_${beliefId}`,
        type: EventTypes.UserBeliefConfirmed,
        source: "orion",
        occurredAt,
        payload: {
          beliefId,
          sessionId,
          confirmedAt: occurredAt,
        },
      });
      return confirmEvent;
    });
  }

  async correctBelief(options: {
    readonly sessionId: string;
    readonly oldBeliefId: string;
    readonly rawCorrectionText: string;
    readonly correctedClaim: string;
    readonly correctedSubject: string;
    readonly correctedCategory: BeliefCategory;
    readonly correctedTemporalScope?: BeliefTemporalScope;
    readonly now?: string;
  }): Promise<{ readonly newBeliefId: string }> {
    const {
      sessionId,
      oldBeliefId,
      rawCorrectionText,
      correctedClaim,
      correctedSubject,
      correctedCategory,
      correctedTemporalScope = "durable",
    } = options;

    const occurredAt = options.now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);
    if (!session || session.status !== "active" || session.isBaselineEstablished) {
      throw new Error(`Cannot correct belief: session ${sessionId} is not active or baseline is established`);
    }

    const oldBelief = session.beliefs.get(oldBeliefId);
    if (!oldBelief) {
      throw new Error(`Belief ${oldBeliefId} not found in session ${sessionId}`);
    }

    // Idempotency check: if oldBelief is already superseded, find existing replacement belief!
    if (oldBelief.status === "superseded") {
      const existingReplacement = Array.from(session.beliefs.values()).find(
        (b) => b.correctedFromBeliefId === oldBeliefId,
      );
      if (existingReplacement) {
        return { newBeliefId: existingReplacement.beliefId };
      }
    }

    if (oldBelief.status !== "proposed" && oldBelief.status !== "confirmed") {
      throw new Error(`Cannot correct belief in status '${oldBelief.status}'`);
    }

    // Validate replacement against Policy Gate
    const policyValidation = this.#policyGate.validateCorrection(
      correctedCategory,
      correctedClaim,
      rawCorrectionText,
    );

    if (!policyValidation.valid || !policyValidation.categoryPolicy) {
      throw new Error(`Correction violates category policy gate or opt-in consent`);
    }

    const newBeliefId = `belief_corr_${sessionId}_${oldBeliefId}`;

    await this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.status !== "active" || sess.isBaselineEstablished) return null;

      const ob = sess.beliefs.get(oldBeliefId);
      if (!ob || (ob.status !== "proposed" && ob.status !== "confirmed")) return null;

      const correctedEvent = makeEvent({
        id: `evt_corr_${newBeliefId}`,
        type: EventTypes.UserBeliefCorrected,
        source: "orion",
        occurredAt,
        payload: {
          oldBeliefId,
          newBeliefId,
          sessionId,
          rawCorrectionText,
          correctedClaim,
          correctedSubject,
          correctedCategory,
          correctedTemporalScope,
          categoryPolicy: policyValidation.categoryPolicy,
          correctedAt: occurredAt,
        },
      });
      return correctedEvent;
    });

    return { newBeliefId };
  }

  async rejectBelief(options: {
    readonly sessionId: string;
    readonly beliefId: string;
    readonly reason?: string;
    readonly now?: string;
  }): Promise<boolean> {
    const { sessionId, beliefId, reason } = options;
    const occurredAt = options.now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);
    if (!session || session.status !== "active" || session.isBaselineEstablished) {
      return false;
    }

    const belief = session.beliefs.get(beliefId);
    if (!belief) return false;
    if (belief.status === "rejected") return true; // Idempotent return
    if (belief.status !== "proposed") return false; // Cannot reject confirmed/superseded

    return this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.status !== "active" || sess.isBaselineEstablished) return null;

      const b = sess.beliefs.get(beliefId);
      if (!b || b.status !== "proposed") return null;

      const rejectEvent = makeEvent({
        id: `evt_rej_${beliefId}`,
        type: EventTypes.UserBeliefRejected,
        source: "orion",
        occurredAt,
        payload: {
          beliefId,
          sessionId,
          reason,
          rejectedAt: occurredAt,
        },
      });
      return rejectEvent;
    });
  }

  async establishBaseline(options: {
    readonly sessionId: string;
    readonly now?: string;
  }): Promise<{ readonly summary: readonly string[]; readonly confirmedBeliefIds: readonly string[] }> {
    const { sessionId } = options;
    const occurredAt = options.now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.isBaselineEstablished) {
      return {
        summary: session.baselineSummary!,
        confirmedBeliefIds: session.baselineConfirmedBeliefIds!,
      };
    }

    if (session.status !== "active") {
      throw new Error(`Cannot establish baseline on session in status '${session.status}'`);
    }

    let summary: readonly string[] = [];
    let confirmedBeliefIds: readonly string[] = [];

    await this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.status !== "active" || sess.isBaselineEstablished) return null;

      const confirmedBeliefs = Array.from(sess.beliefs.values()).filter(
        (b) => b.status === "confirmed",
      );

      confirmedBeliefIds = confirmedBeliefs.map((b) => b.beliefId);
      summary = formatBaselineSummary(confirmedBeliefs);

      const baselineEvent = makeEvent({
        id: `evt_base_${sessionId}`,
        type: EventTypes.UserUnderstandingBaselineEstablished,
        source: "orion",
        occurredAt,
        payload: {
          sessionId,
          confirmedBeliefIds,
          summary,
          establishedAt: occurredAt,
        },
      });
      return baselineEvent;
    });

    return { summary, confirmedBeliefIds };
  }

  async skipSession(sessionId: string, now?: string): Promise<boolean> {
    const occurredAt = now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);
    if (!session || session.isBaselineEstablished) return false;

    if (session.status === "paused") return true; // Idempotent return
    if (session.status !== "active") return false;

    return this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.status !== "active" || sess.isBaselineEstablished) return null;

      const skipEvent = makeEvent({
        id: `evt_skip_${sessionId}_${sess.skipCount + 1}`,
        type: EventTypes.UserOnboardingSkipped,
        source: "orion",
        occurredAt,
        payload: { sessionId, skippedAt: occurredAt },
      });
      return skipEvent;
    });
  }

  async resumeSession(sessionId: string, now?: string): Promise<boolean> {
    const occurredAt = now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);
    if (!session || session.isBaselineEstablished) return false;

    if (session.status === "active") return true; // Idempotent return
    if (session.status !== "paused") return false;

    return this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.status !== "paused" || sess.isBaselineEstablished) return null;

      const resumeEvent = makeEvent({
        id: `evt_res_${sessionId}_${sess.resumeCount + 1}`,
        type: EventTypes.UserOnboardingResumed,
        source: "orion",
        occurredAt,
        payload: { sessionId, resumedAt: occurredAt },
      });
      return resumeEvent;
    });
  }

  async restartSession(
    oldSessionId: string,
    now?: string,
  ): Promise<{ readonly newSessionId: string; readonly questionId: string; readonly questionText: string }> {
    const occurredAt = now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const oldSession = state.sessions.get(oldSessionId);

    if (!oldSession || oldSession.status === "completed") {
      throw new Error(`Cannot restart session ${oldSessionId}: session does not exist or is completed`);
    }

    // Idempotency check: if old session is already abandoned, return existing restarted session
    if (oldSession.status === "abandoned") {
      const existingRestarted = Array.from(state.sessions.values()).find(
        (s) => s.restartedFromSessionId === oldSessionId,
      );
      if (existingRestarted && existingRestarted.turns.length > 0) {
        const firstTurn = existingRestarted.turns[0]!;
        return {
          newSessionId: existingRestarted.sessionId,
          questionId: firstTurn.questionId,
          questionText: firstTurn.questionText,
        };
      }
    }

    const newSessionId = `${oldSessionId}_restarted`;
    const questionText = "What is important to you?";
    const questionId = `q_${newSessionId}_1`;

    await this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const os = s.sessions.get(oldSessionId);
      if (!os || os.status === "completed" || os.status === "abandoned") return null;

      const restartEvent = makeEvent({
        id: `evt_restrt_${oldSessionId}`,
        type: EventTypes.UserOnboardingRestarted,
        source: "orion",
        occurredAt,
        payload: {
          oldSessionId,
          newSessionId,
          restartedAt: occurredAt,
        },
      });
      return restartEvent;
    });

    await this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const ns = s.sessions.get(newSessionId);
      if (!ns || ns.turns.some((t) => t.questionId === questionId)) return null;

      const askedEvent = makeEvent({
        id: `evt_ask_${questionId}`,
        type: EventTypes.UserOnboardingQuestionAsked,
        source: "orion",
        occurredAt,
        payload: {
          questionId,
          sessionId: newSessionId,
          kind: "opening",
          text: questionText,
          ordinal: 1,
          mechanismVersion: "v0.1",
          askedAt: occurredAt,
        },
      });
      return askedEvent;
    });

    return { newSessionId, questionId, questionText };
  }

  async resetSession(
    sessionId: string,
    now?: string,
  ): Promise<{ readonly questionId: string; readonly questionText: string }> {
    const occurredAt = now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);

    if (!session || session.status === "completed") {
      throw new Error(`Cannot reset session ${sessionId}: session does not exist or is completed`);
    }

    const questionText = "What is important to you?";

    // Check if session was ALREADY reset (reset event landed) but needs its opening question
    if (session.turns.length === 0 && session.resetCount > 0) {
      const questionId = `q_${sessionId}_1_reset_${session.resetCount}`;
      await this.#runtime.recordExclusive(() => {
        const s = this.#getProjectionState();
        const sess = s.sessions.get(sessionId);
        if (!sess || sess.turns.some((t) => t.questionId === questionId)) return null;

        const askedEvent = makeEvent({
          id: `evt_ask_${questionId}`,
          type: EventTypes.UserOnboardingQuestionAsked,
          source: "orion",
          occurredAt,
          payload: {
            questionId,
            sessionId,
            kind: "opening",
            text: questionText,
            ordinal: 1,
            mechanismVersion: "v0.1",
            askedAt: occurredAt,
          },
        });
        return askedEvent;
      });
      return { questionId, questionText };
    }

    // Check if opening question for current reset was already asked
    if (session.turns.length === 1 && session.resetCount > 0) {
      const currentTurn = session.turns[0]!;
      if (!currentTurn.statementId && currentTurn.questionId === `q_${sessionId}_1_reset_${session.resetCount}`) {
        return { questionId: currentTurn.questionId, questionText: currentTurn.questionText };
      }
    }

    const newResetCount = session.resetCount + 1;
    const questionId = `q_${sessionId}_1_reset_${newResetCount}`;

    await this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.status === "completed") return null;

      const resetEvent = makeEvent({
        id: `evt_reset_${sessionId}_${newResetCount}`,
        type: EventTypes.UserOnboardingReset,
        source: "orion",
        occurredAt,
        payload: { sessionId, resetAt: occurredAt },
      });
      return resetEvent;
    });

    await this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || sess.turns.some((t) => t.questionId === questionId)) return null;

      const askedEvent = makeEvent({
        id: `evt_ask_${questionId}`,
        type: EventTypes.UserOnboardingQuestionAsked,
        source: "orion",
        occurredAt,
        payload: {
          questionId,
          sessionId,
          kind: "opening",
          text: questionText,
          ordinal: 1,
          mechanismVersion: "v0.1",
          askedAt: occurredAt,
        },
      });
      return askedEvent;
    });

    return { questionId, questionText };
  }

  async deleteBaseline(
    sessionId: string,
    reason?: string,
    now?: string,
  ): Promise<boolean> {
    const occurredAt = now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);
    if (!session || !session.isBaselineEstablished) return false;

    return this.#runtime.recordExclusive(() => {
      const s = this.#getProjectionState();
      const sess = s.sessions.get(sessionId);
      if (!sess || !sess.isBaselineEstablished) return null;

      const delEvent = makeEvent({
        id: `evt_del_base_${sessionId}`,
        type: EventTypes.UserUnderstandingBaselineDeleted,
        source: "orion",
        occurredAt,
        payload: { sessionId, reason, deletedAt: occurredAt },
      });
      return delEvent;
    });
  }
}
