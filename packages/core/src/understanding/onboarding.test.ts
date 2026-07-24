import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "../bus/index.js";
import { EventTypes } from "../domain/index.js";
import { makeEvent } from "../events/index.js";
import { ProjectionHost } from "../projection/index.js";
import { OrionRuntime } from "../runtime/index.js";
import { SqliteEventStore } from "../store/index.js";
import {
  DeterministicPolicyGate,
  OnboardingEngine,
  ScriptedBeliefExtractor,
  cleanClaimText,
  determineSourceEventIds,
  formatBaselineSummary,
  onboardingProjection,
  type BeliefExtractor,
  type CandidateBeliefProposal,
  type ExtractionRequest,
} from "./onboarding.js";

const NOW = "2026-07-24T12:00:00.000Z";

describe("Natural-language onboarding baseline (#70)", () => {
  it("Fixture Journey 1: Rich answer covering family, career, and health", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      const extractor = new ScriptedBeliefExtractor([
        {
          pattern: /family|career|health/i,
          proposals: [
            {
              subject: "family",
              claim: "Family well-being",
              category: "values",
              temporalScope: "durable",
              evidenceText: "Family",
              confidence: 0.9,
            },
            {
              subject: "career",
              claim: "Launching a new software business",
              category: "goals",
              temporalScope: "current",
              evidenceText: "career",
              confidence: 0.85,
            },
            {
              subject: "health",
              claim: "Protecting physical health and exercise",
              category: "priorities",
              temporalScope: "durable",
              evidenceText: "health",
              confidence: 0.8,
            },
          ],
        },
      ]);

      const engine = new OnboardingEngine({
        runtime,
        extractor,
        getProjectionState: () => host.state,
      });

      // 1. Start session
      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_rich_1",
        now: NOW,
      });
      expect(questionId).toBe("q_sess_rich_1_1");

      // 2. Record statement
      const richText = "Family is central to me, I am focused on my career, and protecting my health is critical.";
      const { proposedBeliefs } = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: richText,
        now: NOW,
      });

      expect(proposedBeliefs).toHaveLength(3);

      // Verify health proposal was gated to confirmation_required due to sensitive topic policy
      const healthProposal = proposedBeliefs.find((b) => b.subject === "health")!;
      expect(healthProposal.categoryPolicy).toBe("confirmation_required");

      // 3. User confirms all 3 proposals
      for (const b of proposedBeliefs) {
        const confirmed = await engine.confirmBelief({
          sessionId,
          beliefId: b.beliefId,
          now: NOW,
        });
        expect(confirmed).toBe(true);
      }

      // 4. Establish baseline
      const { summary, confirmedBeliefIds } = await engine.establishBaseline({
        sessionId,
        now: NOW,
      });

      expect(confirmedBeliefIds).toHaveLength(3);
      expect(summary).toContain("Family well-being is central right now.");
      expect(summary.some((s) => s.includes("career") || s.includes("software business"))).toBe(true);
      expect(summary.some((s) => s.includes("health") || s.includes("priority"))).toBe(true);

      const sessionState = host.state.sessions.get(sessionId)!;
      expect(sessionState.isBaselineEstablished).toBe(true);
      expect(sessionState.status).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("Fixture Journey 2: Short answer 'my kids' triggers multi-turn follow-up", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      const extractor = new ScriptedBeliefExtractor([
        {
          pattern: /my kids/i,
          proposals: [
            {
              subject: "children",
              claim: "Parental responsibility for kids",
              category: "roles_and_relationships",
              temporalScope: "durable",
              evidenceText: "my kids",
              confidence: 0.75,
            },
          ],
        },
        {
          pattern: /time together and stability/i,
          proposals: [
            {
              subject: "family_time",
              claim: "Spending quality time with children",
              category: "priorities",
              temporalScope: "current",
              evidenceText: "time together",
              confidence: 0.9,
            },
          ],
        },
      ]);

      const engine = new OnboardingEngine({
        runtime,
        extractor,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId: q1 } = await engine.startSession({
        sessionId: "sess_short_1",
        now: NOW,
      });

      // Turn 1: Short answer
      await engine.recordStatement({
        sessionId,
        questionId: q1,
        rawText: "my kids",
        now: NOW,
      });

      // Ask targeted follow-up question
      const { questionId: q2 } = await engine.askFollowUp({
        sessionId,
        questionText: "What about them matters most to you right now?",
        now: NOW,
      });
      expect(q2).toBe("q_sess_short_1_2");

      // Turn 2: Follow-up response
      const { proposedBeliefs } = await engine.recordStatement({
        sessionId,
        questionId: q2,
        rawText: "Spending quality time together and stability for their future.",
        now: NOW,
      });

      expect(proposedBeliefs).toHaveLength(1);
      const b2 = proposedBeliefs[0]!;
      expect(b2.subject).toBe("family_time");

      await engine.confirmBelief({ sessionId, beliefId: b2.beliefId, now: NOW });
      const { summary } = await engine.establishBaseline({ sessionId, now: NOW });

      expect(summary).toContain("Spending quality time with children is a current working priority.");
    } finally {
      store.close();
    }
  });

  it("Fixture Journey 3: Ambiguous answer 'I don't know right now' pauses session with NO belief", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      const extractor = new ScriptedBeliefExtractor([]);
      const engine = new OnboardingEngine({
        runtime,
        extractor,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_ambig_1",
        now: NOW,
      });

      await engine.handleUncertainty({
        sessionId,
        questionId,
        rawText: "I don't know right now.",
        now: NOW,
      });

      const sessionState = host.state.sessions.get(sessionId)!;
      expect(sessionState.beliefs.size).toBe(0);
      expect(sessionState.turns).toHaveLength(1);
      expect(sessionState.status).toBe("paused");
    } finally {
      store.close();
    }
  });

  it("Fixture Journey 4: Correction and Rejection flow with explicit correction evidence lineage", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      const extractor = new ScriptedBeliefExtractor([
        {
          pattern: /work and sports/i,
          proposals: [
            {
              subject: "work",
              claim: "High workload",
              category: "priorities",
              temporalScope: "current",
              evidenceText: "work",
              confidence: 0.8,
            },
            {
              subject: "sports",
              claim: "Watching professional sports games",
              category: "routines",
              temporalScope: "current",
              evidenceText: "sports",
              confidence: 0.7,
            },
          ],
        },
      ]);

      const engine = new OnboardingEngine({
        runtime,
        extractor,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_corr_1",
        now: NOW,
      });

      const { proposedBeliefs } = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "I am balancing work and sports.",
        now: NOW,
      });

      const workBelief = proposedBeliefs.find((b) => b.subject === "work")!;
      const sportsBelief = proposedBeliefs.find((b) => b.subject === "sports")!;

      // User rejects sports
      const rejected = await engine.rejectBelief({
        sessionId,
        beliefId: sportsBelief.beliefId,
        reason: "Not a priority",
        now: NOW,
      });
      expect(rejected).toBe(true);

      // User corrects work belief
      const { newBeliefId } = await engine.correctBelief({
        sessionId,
        oldBeliefId: workBelief.beliefId,
        rawCorrectionText: "I am focused on launching my startup, not general work.",
        correctedClaim: "Launching startup",
        correctedSubject: "startup_launch",
        correctedCategory: "goals",
        correctedTemporalScope: "current",
        now: NOW,
      });

      const sessionState = host.state.sessions.get(sessionId)!;
      expect(sessionState.beliefs.get(sportsBelief.beliefId)!.status).toBe("rejected");
      expect(sessionState.beliefs.get(workBelief.beliefId)!.status).toBe("superseded");

      const replacement = sessionState.beliefs.get(newBeliefId)!;
      expect(replacement.status).toBe("confirmed");
      expect(replacement.derivation).toBe("declared_directly");
      expect(replacement.verification).toBe("user_confirmed");
      // Explicit correction evidence lineage: sourceEventIds contains strictly the correction event envelope ID
      expect(replacement.sourceEventIds).toEqual([`evt_corr_${newBeliefId}`]);
      expect(replacement.correctedFromBeliefId).toBe(workBelief.beliefId);

      // Establish baseline
      const { confirmedBeliefIds, summary } = await engine.establishBaseline({
        sessionId,
        now: NOW,
      });

      expect(confirmedBeliefIds).toEqual([newBeliefId]);
      expect(summary).toContain("You are focused on launching startup.");
    } finally {
      store.close();
    }
  });

  it("Opt-In Extraction Gating: Pre-extraction category filtering and post-consent effective policy", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      let capturedEligibleCategories: ReadonlySet<string> | undefined;

      const mockExtractor: BeliefExtractor = {
        async extractCandidates(request: ExtractionRequest) {
          capturedEligibleCategories = new Set(request.eligibleCategories);
          return [
            {
              subject: "routine",
              claim: "Morning routine at 6 AM",
              category: "routines",
              temporalScope: "current",
              evidenceText: "daily routine",
              supportingEvidence: [
                { statementEnvelopeId: request.currentStatementEnvelopeId, evidenceText: "daily routine" },
              ],
              confidence: 0.9,
            },
          ];
        },
      };

      // Gate requiring opt-in for routines, consent NOT granted
      const unconsentedGate = new DeterministicPolicyGate({
        optInCategories: new Set(["routines"]),
        grantedConsentCategories: new Set(),
      });

      const engine = new OnboardingEngine({
        runtime,
        extractor: mockExtractor,
        policyGate: unconsentedGate,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_opt_test_1",
        now: NOW,
      });

      const { proposedBeliefs } = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "My daily routine starts at 6 AM.",
        now: NOW,
      });

      // Pre-extraction eligibleCategories passed to extractor MUST NOT contain 'routines'
      expect(capturedEligibleCategories).toBeDefined();
      expect(capturedEligibleCategories!.has("routines")).toBe(false);

      // No proposals created
      expect(proposedBeliefs).toHaveLength(0);

      // Now with granted consent
      const consentedGate = new DeterministicPolicyGate({
        optInCategories: new Set(["routines"]),
        grantedConsentCategories: new Set(["routines"]),
      });

      const consentedEngine = new OnboardingEngine({
        runtime,
        extractor: mockExtractor,
        policyGate: consentedGate,
        getProjectionState: () => host.state,
      });

      const { sessionId: s2, questionId: q2 } = await consentedEngine.startSession({
        sessionId: "sess_opt_test_2",
        now: NOW,
      });

      const { proposedBeliefs: consentedBeliefs } = await consentedEngine.recordStatement({
        sessionId: s2,
        questionId: q2,
        rawText: "My daily routine starts at 6 AM.",
        now: NOW,
      });

      expect(capturedEligibleCategories!.has("routines")).toBe(true);
      expect(consentedBeliefs).toHaveLength(1);
      // Post-consent effective policy is 'allowed'
      expect(consentedBeliefs[0]!.categoryPolicy).toBe("allowed");
    } finally {
      store.close();
    }
  });

  it("Statement Processing Retry Safety & Failure Recovery", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      let throwCount = 0;
      const failingExtractor: BeliefExtractor = {
        async extractCandidates(request: ExtractionRequest) {
          if (throwCount === 0) {
            throwCount++;
            throw new Error("Simulated extraction crash after statement recording!");
          }
          return [
            {
              subject: "coding",
              claim: "Building software",
              category: "goals",
              temporalScope: "current",
              evidenceText: "writing code",
              supportingEvidence: [
                { statementEnvelopeId: request.currentStatementEnvelopeId, evidenceText: "writing code" },
              ],
              confidence: 0.9,
            },
          ];
        },
      };

      const engine = new OnboardingEngine({
        runtime,
        extractor: failingExtractor,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_retry_1",
        now: NOW,
      });

      const stmtText = "I spend most of my time writing code.";

      // First call fails during extraction AFTER UserStatementRecorded landed on log
      await expect(
        engine.recordStatement({
          sessionId,
          questionId,
          rawText: stmtText,
          now: NOW,
        }),
      ).rejects.toThrow("Simulated extraction crash");

      // Verify UserStatementRecorded was persisted on state
      const sessionState = host.state.sessions.get(sessionId)!;
      const turn = sessionState.turns.find((t) => t.questionId === questionId)!;
      expect(turn.statementId).toBeDefined();
      expect(turn.rawStatementText).toBe(stmtText);
      expect(turn.isStatementProcessed).toBeFalsy();

      // Retry recordStatement: resumes using persisted statement text and succeeds
      const retryResult = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "Different unpersisted text on retry",
        now: NOW,
      });

      expect(retryResult.statementId).toBe(turn.statementId);
      expect(retryResult.proposedBeliefs).toHaveLength(1);
      expect(retryResult.proposedBeliefs[0]!.subject).toBe("coding");

      // Statement is now marked processed
      expect(host.state.sessions.get(sessionId)!.turns[0]!.isStatementProcessed).toBe(true);
    } finally {
      store.close();
    }
  });

  it("Concurrency Safety: Concurrent recordStatement calls use recorded statement text", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      const extractor = new ScriptedBeliefExtractor([
        {
          pattern: /Text A/i,
          proposals: [
            {
              subject: "topic_a",
              claim: "Topic A proposal",
              category: "priorities",
              temporalScope: "current",
              evidenceText: "Text A",
              confidence: 0.9,
            },
          ],
        },
        {
          pattern: /Text B/i,
          proposals: [
            {
              subject: "topic_b",
              claim: "Topic B proposal",
              category: "priorities",
              temporalScope: "current",
              evidenceText: "Text B",
              confidence: 0.9,
            },
          ],
        },
      ]);

      const engine = new OnboardingEngine({
        runtime,
        extractor,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_concurrent_1",
        now: NOW,
      });

      // Call A and Call B executed concurrently
      const [resA, resB] = await Promise.all([
        engine.recordStatement({ sessionId, questionId, rawText: "I am focusing on Text A.", now: NOW }),
        engine.recordStatement({ sessionId, questionId, rawText: "I am focusing on Text B.", now: NOW }),
      ]);

      // Both calls return the exact same statement ID and envelope ID
      expect(resA.statementId).toBe(resB.statementId);
      expect(resA.statementEnvelopeId).toBe(resB.statementEnvelopeId);

      // Whichever text landed first is used by both returns; no cross-contamination or Topic B derived from Text A
      expect(resA.proposedBeliefs).toEqual(resB.proposedBeliefs);
      expect(resA.proposedBeliefs).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("Enforces Single Pending Question rule in askFollowUp", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      const extractor = new ScriptedBeliefExtractor([]);
      const engine = new OnboardingEngine({
        runtime,
        extractor,
        getProjectionState: () => host.state,
      });

      const { sessionId } = await engine.startSession({
        sessionId: "sess_pending_q_1",
        now: NOW,
      });

      // Opening question is pending (unanswered). Attempting askFollowUp returns existing pending question!
      const followUp1 = await engine.askFollowUp({
        sessionId,
        questionText: "Different follow-up wording",
        now: NOW,
      });

      expect(followUp1.questionId).toBe("q_sess_pending_q_1_1");
      expect(followUp1.questionText).toBe("What is important to you?");

      // Session turns length remains 1
      expect(host.state.sessions.get(sessionId)!.turns).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("Reset Session Command Identity on retry", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      const extractor = new ScriptedBeliefExtractor([]);
      const engine = new OnboardingEngine({
        runtime,
        extractor,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_reset_retry_1",
        now: NOW,
      });

      await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "First statement",
        now: NOW,
      });

      // Reset session
      const reset1 = await engine.resetSession(sessionId, NOW);
      expect(reset1.questionId).toBe("q_sess_reset_retry_1_1_reset_1");

      // Retrying resetSession while unanswered question pending returns existing reset opening question
      const reset2 = await engine.resetSession(sessionId, NOW);
      expect(reset2.questionId).toBe(reset1.questionId);

      const sessionState = host.state.sessions.get(sessionId)!;
      expect(sessionState.resetCount).toBe(1);
      expect(sessionState.turns).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("Durable extraction snapshot: failure between proposals reuses persisted extraction snapshot on retry", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      let extractCallCount = 0;
      const nondeterministicExtractor: BeliefExtractor = {
        async extractCandidates(request: ExtractionRequest) {
          extractCallCount++;
          if (extractCallCount === 1) {
            return [
              {
                subject: "health",
                claim: "Daily workout",
                category: "routines",
                temporalScope: "current",
                evidenceText: "working out daily",
                supportingEvidence: [
                  { statementEnvelopeId: request.currentStatementEnvelopeId, evidenceText: "working out daily" },
                ],
                confidence: 0.8,
              },
            ];
          }
          // Nondeterministic second call produces different candidate!
          return [
            {
              subject: "diet",
              claim: "Eating healthy diet",
              category: "routines",
              temporalScope: "current",
              evidenceText: "working out daily",
              supportingEvidence: [
                { statementEnvelopeId: request.currentStatementEnvelopeId, evidenceText: "working out daily" },
              ],
              confidence: 0.8,
            },
          ];
        },
      };

      const engine = new OnboardingEngine({
        runtime,
        extractor: nondeterministicExtractor,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_snap_1",
        now: NOW,
      });

      const res = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "I am working out daily.",
        now: NOW,
      });

      expect(extractCallCount).toBe(1);
      expect(res.proposedBeliefs).toHaveLength(1);
      expect(res.proposedBeliefs[0]!.subject).toBe("health");

      // Verify that extraction snapshot is stored on turn
      const sessionState = host.state.sessions.get(sessionId)!;
      const turn = sessionState.turns.find((t) => t.questionId === questionId)!;
      expect(turn.isStatementProcessed).toBe(true);
      expect(turn.extractionSnapshot).toBeDefined();
      expect(turn.extractionSnapshot![0]!.subject).toBe("health");

      // Retry recordStatement does NOT call extractor again; it returns persisted proposals
      const retryRes = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "I am working out daily.",
        now: NOW,
      });

      expect(extractCallCount).toBe(1); // Extractor was NOT rerun!
      expect(retryRes.proposedBeliefs[0]!.subject).toBe("health");
    } finally {
      store.close();
    }
  });

  it("Item 1: Durable snapshot persists ONLY post-policy validated candidates", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      // Policy gate: opt-in required for values, no consent granted
      const policyGate = new DeterministicPolicyGate({
        optInCategories: new Set(["values"]),
        grantedConsentCategories: new Set([]),
      });

      // Extractor ignores eligibleCategories and attempts to return unconsented opt-in candidate + prohibited topic candidate + valid candidate
      const rogueExtractor: BeliefExtractor = {
        async extractCandidates(request: ExtractionRequest) {
          return [
            {
              subject: "unconsented_value",
              claim: "Family well-being",
              category: "values",
              temporalScope: "durable",
              evidenceText: "family focus",
              supportingEvidence: [
                { statementEnvelopeId: request.currentStatementEnvelopeId, evidenceText: "family focus" },
              ],
              confidence: 0.9,
            },
            {
              subject: "career",
              claim: "Building software business",
              category: "goals",
              temporalScope: "current",
              evidenceText: "building software",
              supportingEvidence: [
                { statementEnvelopeId: request.currentStatementEnvelopeId, evidenceText: "building software" },
              ],
              confidence: 0.95,
            },
          ];
        },
      };

      const engine = new OnboardingEngine({
        runtime,
        extractor: rogueExtractor,
        policyGate,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_policy_snap_1",
        now: NOW,
      });

      const res = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "I am building software with family focus.",
        now: NOW,
      });

      // Only the valid post-policy candidate was proposed!
      expect(res.proposedBeliefs).toHaveLength(1);
      expect(res.proposedBeliefs[0]!.subject).toBe("career");

      // Verify that extraction snapshot in event log contains ONLY post-policy candidates!
      const sessionState = host.state.sessions.get(sessionId)!;
      const turn = sessionState.turns.find((t) => t.questionId === questionId)!;
      expect(turn.extractionSnapshot).toHaveLength(1);
      expect(turn.extractionSnapshot![0]!.subject).toBe("career");
      expect(turn.extractionSnapshot![0]!.categoryPolicy).toBe("allowed");
      expect(turn.policyVersion).toBe("v0.1");
    } finally {
      store.close();
    }
  });

  it("Item 2: establishBaseline rejects unmaterialized statement results & failure-between-proposals is retryable", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const bus = new InProcessEventBus();
      const host = new ProjectionHost(onboardingProjection);
      const runtime = new OrionRuntime({
        bus,
        store,
        projections: [host as ProjectionHost<unknown>],
      });

      const multiProposalExtractor: BeliefExtractor = {
        async extractCandidates(request: ExtractionRequest) {
          return [
            {
              subject: "family",
              claim: "Family well-being",
              category: "values",
              temporalScope: "durable",
              evidenceText: "family",
              supportingEvidence: [
                { statementEnvelopeId: request.currentStatementEnvelopeId, evidenceText: "family" },
              ],
              confidence: 0.9,
            },
            {
              subject: "career",
              claim: "Career growth",
              category: "goals",
              temporalScope: "current",
              evidenceText: "career",
              supportingEvidence: [
                { statementEnvelopeId: request.currentStatementEnvelopeId, evidenceText: "career" },
              ],
              confidence: 0.9,
            },
          ];
        },
      };

      const engine = new OnboardingEngine({
        runtime,
        extractor: multiProposalExtractor,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_materialize_1",
        now: NOW,
      });

      const statementId = `stmt_${sessionId}_${questionId}`;
      const statementEnvelopeId = `evt_stmt_${statementId}`;
      const rawText = "My family and career matter.";

      // Record statement event
      await runtime.record(
        makeEvent({
          id: statementEnvelopeId,
          type: EventTypes.UserStatementRecorded,
          source: "orion",
          occurredAt: NOW,
          payload: {
            statementId,
            sessionId,
            questionId,
            rawText,
            recordedAt: NOW,
          },
        }),
      );

      const candidate1 = {
        subject: "family",
        claim: "Family well-being",
        category: "values" as const,
        temporalScope: "durable" as const,
        evidenceText: "family",
        supportingEvidence: [{ statementEnvelopeId, evidenceText: "family" }],
        confidence: 0.9,
        categoryPolicy: "allowed" as const,
        sourceEventIds: [statementEnvelopeId],
      };

      const candidate2 = {
        subject: "career",
        claim: "Career growth",
        category: "goals" as const,
        temporalScope: "current" as const,
        evidenceText: "career",
        supportingEvidence: [{ statementEnvelopeId, evidenceText: "career" }],
        confidence: 0.9,
        categoryPolicy: "allowed" as const,
        sourceEventIds: [statementEnvelopeId],
      };

      const belief1Id = `belief_${sessionId}_${statementId}_0_family_well_being`;
      const belief2Id = `belief_${sessionId}_${statementId}_1_career_growth`;

      // Record UserStatementProcessed event with 2 expected belief IDs
      await runtime.record(
        makeEvent({
          id: `evt_stmt_proc_${statementId}`,
          type: EventTypes.UserStatementProcessed,
          source: "orion",
          occurredAt: NOW,
          payload: {
            statementId,
            statementEnvelopeId,
            sessionId,
            questionId,
            extractionResult: [candidate1, candidate2],
            proposedBeliefIds: [belief1Id, belief2Id],
            policyVersion: "v0.1",
            processedAt: NOW,
          },
        }),
      );

      // Record ONLY proposal 1 event (simulating crash before proposal 2)
      await runtime.record(
        makeEvent({
          id: `evt_prop_${belief1Id}`,
          type: EventTypes.UserBeliefProposed,
          source: "orion",
          occurredAt: NOW,
          payload: {
            beliefId: belief1Id,
            sessionId,
            statementEnvelopeId,
            subject: candidate1.subject,
            claim: candidate1.claim,
            category: candidate1.category,
            temporalScope: candidate1.temporalScope,
            evidenceText: candidate1.evidenceText,
            origin: "user_statement",
            derivation: "ai_assisted_inference",
            verification: "unconfirmed",
            sourceEventIds: candidate1.sourceEventIds,
            confidence: candidate1.confidence,
            categoryPolicy: candidate1.categoryPolicy,
            inferenceMechanism: "v0.1",
            promptSchemaVersion: "v0.1",
            validFrom: NOW,
            proposedAt: NOW,
          },
        }),
      );

      // Verify turn.isStatementProcessed is FALSE because proposal 2 is unmaterialized
      expect(host.state.sessions.get(sessionId)!.turns[0]!.isStatementProcessed).toBe(false);

      // 1. establishBaseline MUST REJECT because proposal 2 is unmaterialized!
      await expect(
        engine.establishBaseline({ sessionId, now: NOW }),
      ).rejects.toThrow(/unmaterialized statement results/i);

      // 2. Retry recordStatement completes proposal 2 without re-running extraction
      const retryRes = await engine.recordStatement({
        sessionId,
        questionId,
        rawText,
        now: NOW,
      });

      expect(retryRes.proposedBeliefs).toHaveLength(2);
      expect(host.state.sessions.get(sessionId)!.turns[0]!.isStatementProcessed).toBe(true);

      // 3. Confirm beliefs and establish baseline now succeeds
      await engine.confirmBelief({ sessionId, beliefId: retryRes.proposedBeliefs[0]!.beliefId, now: NOW });
      await engine.confirmBelief({ sessionId, beliefId: retryRes.proposedBeliefs[1]!.beliefId, now: NOW });

      const baseline = await engine.establishBaseline({ sessionId, now: NOW });
      expect(baseline.summary).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("Item 3: Requires non-empty supportingEvidence & validates top-level evidenceText match", async () => {
    const policyGate = new DeterministicPolicyGate();
    const request: ExtractionRequest = {
      currentQuestion: "What matters to you?",
      currentStatement: "Family is central to my daily life.",
      currentStatementEnvelopeId: "evt_stmt_100",
      priorTurns: [],
      eligibleCategories: policyGate.getEligibleCategories(),
    };

    // A. Missing / empty supportingEvidence -> rejected
    const candidateNoEvidence = {
      subject: "family",
      claim: "Family focus",
      category: "values" as const,
      temporalScope: "durable" as const,
      evidenceText: "Family",
      supportingEvidence: [],
      confidence: 0.9,
    };
    expect(policyGate.validateCandidate(candidateNoEvidence, request).valid).toBe(false);

    // B. Top-level evidenceText does not contain referenced evidence span -> rejected
    const candidateMismatchText = {
      subject: "family",
      claim: "Family focus",
      category: "values" as const,
      temporalScope: "durable" as const,
      evidenceText: "Unsupported top-level text",
      supportingEvidence: [{ statementEnvelopeId: "evt_stmt_100", evidenceText: "Family" }],
      confidence: 0.9,
    };
    expect(policyGate.validateCandidate(candidateMismatchText, request).valid).toBe(false);

    // C. supportingEvidence text not in statement -> rejected
    const candidateWrongSpan = {
      subject: "family",
      claim: "Family focus",
      category: "values" as const,
      temporalScope: "durable" as const,
      evidenceText: "completely absent span",
      supportingEvidence: [{ statementEnvelopeId: "evt_stmt_100", evidenceText: "completely absent span" }],
      confidence: 0.9,
    };
    expect(policyGate.validateCandidate(candidateWrongSpan, request).valid).toBe(false);

    // D. Valid matching explicit supportingEvidence -> accepted
    const candidateValid = {
      subject: "family",
      claim: "Family focus",
      category: "values" as const,
      temporalScope: "durable" as const,
      evidenceText: "Family is central",
      supportingEvidence: [{ statementEnvelopeId: "evt_stmt_100", evidenceText: "Family is central" }],
      confidence: 0.9,
    };
    const validRes = policyGate.validateCandidate(candidateValid, request);
    expect(validRes.valid).toBe(true);
    expect(validRes.sourceEventIds).toEqual(["evt_stmt_100"]);
  });

  it("Item 4: Non-backtracking claim normalization handles adversarial trailing whitespace efficiently", () => {
    const claimWithAdversarialSpaces = "Family well-being is top value" + " ".repeat(50000);

    const start = performance.now();
    const cleaned = cleanClaimText(claimWithAdversarialSpaces);
    const duration = performance.now() - start;

    expect(cleaned).toBe("Family well-being");
    expect(duration).toBeLessThan(50);
  });
});
