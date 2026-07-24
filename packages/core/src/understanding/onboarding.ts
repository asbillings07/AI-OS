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
}

export interface CandidateBeliefProposal {
  readonly subject: string;
  readonly claim: string;
  readonly category: BeliefCategory;
  readonly temporalScope: BeliefTemporalScope;
  readonly evidenceText: string;
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

export interface PolicyGateOptions {
  readonly optInCategories?: ReadonlySet<BeliefCategory>;
  readonly prohibitedCategories?: ReadonlySet<BeliefCategory>;
}

export class DeterministicPolicyGate {
  readonly #optInCategories: ReadonlySet<BeliefCategory>;
  readonly #prohibitedCategories: ReadonlySet<BeliefCategory>;

  constructor(options: PolicyGateOptions = {}) {
    this.#optInCategories = options.optInCategories ?? new Set();
    this.#prohibitedCategories = options.prohibitedCategories ?? new Set();
  }

  /**
   * Pre-Extraction Gate: Checks whether extraction is allowed for a category and text.
   * Returns false if the category is prohibited or if opt-in consent is required but not granted.
   */
  isExtractionAllowed(category: BeliefCategory, text: string): boolean {
    if (this.#prohibitedCategories.has(category)) {
      return false;
    }
    if (PROHIBITED_PATTERN.test(text)) {
      return false;
    }
    return true;
  }

  /**
   * Post-Extraction Validation Gate:
   * Validates evidence spans, assigns categoryPolicy ("allowed", "confirmation_required", or "opt_in"),
   * and drops invalid or prohibited candidates.
   */
  validateCandidate(
    candidate: CandidateBeliefProposal,
    request: ExtractionRequest,
  ): { readonly valid: boolean; readonly categoryPolicy?: "allowed" | "confirmation_required" | "opt_in" } {
    if (this.#prohibitedCategories.has(candidate.category)) {
      return { valid: false };
    }

    if (PROHIBITED_PATTERN.test(candidate.claim) || PROHIBITED_PATTERN.test(candidate.evidenceText)) {
      return { valid: false };
    }

    // Verify evidenceText is a non-empty verbatim substring of current statement or a prior turn
    const allText = [
      request.currentStatement,
      ...request.priorTurns.map((t) => t.statement),
    ].join("\n");

    const trimmedEvidence = candidate.evidenceText.trim();
    if (trimmedEvidence.length === 0 || !allText.includes(trimmedEvidence)) {
      return { valid: false };
    }

    // Check sensitive content keywords across claim, evidence, or current statement
    const isSensitive =
      SENSITIVE_TOPIC_PATTERN.test(candidate.claim) ||
      SENSITIVE_TOPIC_PATTERN.test(candidate.evidenceText) ||
      SENSITIVE_TOPIC_PATTERN.test(request.currentStatement);

    let categoryPolicy: "allowed" | "confirmation_required" | "opt_in" = "allowed";

    if (this.#optInCategories.has(candidate.category)) {
      categoryPolicy = "opt_in";
    } else if (isSensitive) {
      categoryPolicy = "confirmation_required";
    }

    return {
      valid: true,
      categoryPolicy,
    };
  }
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
        candidates.push(...rule.proposals);
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
  if (!session) return state;

  const existing = session.beliefs.get(beliefId);
  if (!existing || existing.status === "confirmed") return state;

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
  } = event.payload;

  const session = state.sessions.get(sessionId);
  if (!session) return state;

  const oldBelief = session.beliefs.get(oldBeliefId);
  if (!oldBelief) return state;

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
    sourceEventIds: [...oldBelief.sourceEventIds, event.id],
    confidence: 1.0,
    categoryPolicy: "allowed",
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
  if (!session) return state;

  const existing = session.beliefs.get(beliefId);
  if (!existing || existing.status === "rejected") return state;

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
  if (!session) return state;

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
    status: "active",
    turns: [],
    beliefs: new Map(),
    isBaselineEstablished: false,
    isBaselineDeleted: false,
  };

  sessions.set(newSessionId, newSession);
  return { ...state, sessions, activeSessionId: newSessionId };
}

function foldReset(state: OnboardingState, event: UserOnboardingResetEvent): OnboardingState {
  const { sessionId } = event.payload;
  const session = state.sessions.get(sessionId);
  if (!session) return state;

  const updatedSession: OnboardingSessionState = {
    ...session,
    turns: [],
    beliefs: new Map(),
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
        return `You are focused on ${b.claim.toLowerCase().replace(/^\b/, "")}.`;
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
    const statementId = `stmt_${sessionId}_${questionId}`;
    const occurredAt = options.now ?? new Date().toISOString();
    let statementEnvelopeId = `evt_stmt_${statementId}`;

    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || session.status !== "active") return null;

      const turn = session.turns.find((t) => t.questionId === questionId);
      if (!turn || turn.statementId) return null;

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

    // Re-read projection to assemble ExtractionRequest
    const stateAfterStmt = this.#getProjectionState();
    const sessionAfterStmt = stateAfterStmt.sessions.get(sessionId)!;
    const currentTurn = sessionAfterStmt.turns.find((t) => t.questionId === questionId)!;
    if (currentTurn.statementEnvelopeId) {
      statementEnvelopeId = currentTurn.statementEnvelopeId;
    }

    const priorTurns: ExtractionTurn[] = sessionAfterStmt.turns
      .filter((t) => t.questionId !== questionId && t.statementEnvelopeId && t.rawStatementText)
      .map((t) => ({
        question: t.questionText,
        statement: t.rawStatementText!,
        statementEnvelopeId: t.statementEnvelopeId!,
      }));

    const sourceEventIds = [
      ...priorTurns.map((t) => t.statementEnvelopeId),
      statementEnvelopeId,
    ];

    const extractionRequest: ExtractionRequest = {
      currentQuestion: currentTurn.questionText,
      currentStatement: rawText,
      currentStatementEnvelopeId: statementEnvelopeId,
      priorTurns,
    };

    // Pre-extraction gate check
    const isAllowed = this.#policyGate.isExtractionAllowed("values", rawText);
    const proposedBeliefs: OnboardingBeliefState[] = [];

    if (isAllowed) {
      const candidates = await this.#extractor.extractCandidates(extractionRequest);

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        const validation = this.#policyGate.validateCandidate(candidate, extractionRequest);

        if (!validation.valid || !validation.categoryPolicy) {
          continue; // Prohibited or invalid candidate dropped
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
              sourceEventIds,
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
      }
    }

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
  }): Promise<{ readonly questionId: string; readonly text: string }> {
    const { sessionId, questionText } = options;
    const occurredAt = options.now ?? new Date().toISOString();

    const state = this.#getProjectionState();
    const session = state.sessions.get(sessionId);
    if (!session || session.status !== "active") {
      throw new Error(`Cannot ask follow-up: session ${sessionId} is not active`);
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

    return { questionId, text: questionText };
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

    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || session.status !== "active") return null;

      const turn = session.turns.find((t) => t.questionId === questionId);
      if (!turn || turn.statementId) return null;

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

    return { statementId };
  }

  async confirmBelief(options: {
    readonly sessionId: string;
    readonly beliefId: string;
    readonly now?: string;
  }): Promise<boolean> {
    const { sessionId, beliefId } = options;
    const occurredAt = options.now ?? new Date().toISOString();

    return this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session) return null;

      const belief = session.beliefs.get(beliefId);
      if (!belief || belief.status === "confirmed" || belief.status === "superseded") return null;

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
    const newBeliefId = `belief_corr_${sessionId}_${oldBeliefId}_${Date.now()}`;

    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session) return null;

      const oldBelief = session.beliefs.get(oldBeliefId);
      if (!oldBelief || oldBelief.status === "superseded") return null;

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

    return this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session) return null;

      const belief = session.beliefs.get(beliefId);
      if (!belief || belief.status === "rejected" || belief.status === "superseded") return null;

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

    let summary: readonly string[] = [];
    let confirmedBeliefIds: readonly string[] = [];

    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || session.isBaselineEstablished) return null;

      const confirmedBeliefs = Array.from(session.beliefs.values()).filter(
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
    return this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || session.status !== "active") return null;

      const skipEvent = makeEvent({
        id: `evt_skip_${sessionId}`,
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
    return this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || session.status !== "paused") return null;

      const resumeEvent = makeEvent({
        id: `evt_res_${sessionId}`,
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
    const newSessionId = `session_restarted_${Date.now()}`;
    const questionText = "What is important to you?";
    const questionId = `q_${newSessionId}_1`;

    await this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const oldSession = state.sessions.get(oldSessionId);
      if (!oldSession) return null;

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
      const state = this.#getProjectionState();
      const newSession = state.sessions.get(newSessionId);
      if (!newSession || newSession.turns.some((t) => t.questionId === questionId)) return null;

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

  async resetSession(sessionId: string, now?: string): Promise<boolean> {
    const occurredAt = now ?? new Date().toISOString();
    return this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session) return null;

      const resetEvent = makeEvent({
        id: `evt_reset_${sessionId}`,
        type: EventTypes.UserOnboardingReset,
        source: "orion",
        occurredAt,
        payload: { sessionId, resetAt: occurredAt },
      });
      return resetEvent;
    });
  }

  async deleteBaseline(
    sessionId: string,
    reason?: string,
    now?: string,
  ): Promise<boolean> {
    const occurredAt = now ?? new Date().toISOString();
    return this.#runtime.recordExclusive(() => {
      const state = this.#getProjectionState();
      const session = state.sessions.get(sessionId);
      if (!session || !session.isBaselineEstablished) return null;

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

