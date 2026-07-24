import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "../bus/index.js";
import { ProjectionHost } from "../projection/index.js";
import { OrionRuntime } from "../runtime/index.js";
import { SqliteEventStore } from "../store/index.js";
import {
  DeterministicPolicyGate,
  OnboardingEngine,
  ScriptedBeliefExtractor,
  determineSourceEventIds,
  onboardingProjection,
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
      expect(sessionState.status).toBe("paused"); // Terminal paused state reached
    } finally {
      store.close();
    }
  });

  it("Fixture Journey 4: Correction and Rejection flow", async () => {
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

      // Attempting to confirm rejected belief fails
      const confirmRejected = await engine.confirmBelief({
        sessionId,
        beliefId: sportsBelief.beliefId,
        now: NOW,
      });
      expect(confirmRejected).toBe(false);

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

  it("Fixture Journey 5: Repeated skip/resume, Retry idempotency, Baseline deletion, and Replay", async () => {
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
          pattern: /writing code/i,
          proposals: [
            {
              subject: "coding",
              claim: "Building Orion software",
              category: "priorities",
              temporalScope: "current",
              evidenceText: "writing code",
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
        sessionId: "sess_life_1",
        now: NOW,
      });

      // Test repeated skip & resume cycles (sequence-aware event IDs)
      await engine.skipSession(sessionId, NOW);
      expect(host.state.sessions.get(sessionId)!.status).toBe("paused");
      expect(host.state.sessions.get(sessionId)!.skipCount).toBe(1);

      await engine.resumeSession(sessionId, NOW);
      expect(host.state.sessions.get(sessionId)!.status).toBe("active");
      expect(host.state.sessions.get(sessionId)!.resumeCount).toBe(1);

      await engine.skipSession(sessionId, NOW);
      expect(host.state.sessions.get(sessionId)!.skipCount).toBe(2);

      await engine.resumeSession(sessionId, NOW);
      expect(host.state.sessions.get(sessionId)!.resumeCount).toBe(2);

      // Retry recordStatement idempotency
      const res1 = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "I spend most of my time writing code.",
        now: NOW,
      });

      // Retrying recordStatement with different rawText on answered question returns existing statement
      const res2 = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "Different text provided on retry",
        now: NOW,
      });

      expect(res1.statementId).toBe(res2.statementId);
      expect(res1.statementEnvelopeId).toBe(res2.statementEnvelopeId);
      expect(res1.proposedBeliefs).toHaveLength(1);
      expect(res2.proposedBeliefs).toEqual(res1.proposedBeliefs);

      const b = res1.proposedBeliefs[0]!;
      await engine.confirmBelief({ sessionId, beliefId: b.beliefId, now: NOW });
      await engine.establishBaseline({ sessionId, now: NOW });

      expect(host.state.sessions.get(sessionId)!.isBaselineEstablished).toBe(true);

      // Test Delete Baseline (Privacy)
      await engine.deleteBaseline(sessionId, "User requested privacy deletion", NOW);

      const deletedState = host.state.sessions.get(sessionId)!;
      expect(deletedState.isBaselineEstablished).toBe(false);
      expect(deletedState.isBaselineDeleted).toBe(true);
      expect(deletedState.baselineSummary).toBeUndefined();

      // Test Replay parity
      const replayedHost = new ProjectionHost(onboardingProjection);
      const replayedRuntime = new OrionRuntime({
        bus: new InProcessEventBus(),
        store,
        projections: [replayedHost as ProjectionHost<unknown>],
      });

      await replayedRuntime.rebuild();
      expect(replayedHost.state.sessions.get(sessionId)!.isBaselineDeleted).toBe(true);
      expect(replayedHost.state.sessions.get(sessionId)!.isBaselineEstablished).toBe(false);
    } finally {
      store.close();
    }
  });

  it("Opt-in Consent & Policy Gate blocks unconsented categories completely before extraction payload", async () => {
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
          pattern: /daily routine/i,
          proposals: [
            {
              subject: "routine",
              claim: "Morning routine at 6 AM",
              category: "routines",
              temporalScope: "current",
              evidenceText: "daily routine",
              confidence: 0.9,
            },
          ],
        },
      ]);

      // Unconsented policy gate (routines requires opt-in consent, not granted)
      const unconsentedGate = new DeterministicPolicyGate({
        optInCategories: new Set(["routines"]),
        grantedConsentCategories: new Set(),
      });

      const engine = new OnboardingEngine({
        runtime,
        extractor,
        policyGate: unconsentedGate,
        getProjectionState: () => host.state,
      });

      const { sessionId, questionId } = await engine.startSession({
        sessionId: "sess_opt_1",
        now: NOW,
      });

      const { proposedBeliefs } = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "My daily routine starts at 6 AM.",
        now: NOW,
      });

      // No candidate or belief proposal payload exists before consent!
      expect(proposedBeliefs).toHaveLength(0);
      expect(host.state.sessions.get(sessionId)!.beliefs.size).toBe(0);

      // Now grant consent
      const consentedGate = new DeterministicPolicyGate({
        optInCategories: new Set(["routines"]),
        grantedConsentCategories: new Set(["routines"]),
      });

      const consentedEngine = new OnboardingEngine({
        runtime,
        extractor,
        policyGate: consentedGate,
        getProjectionState: () => host.state,
      });

      const { sessionId: s2, questionId: q2 } = await consentedEngine.startSession({
        sessionId: "sess_opt_2",
        now: NOW,
      });

      const { proposedBeliefs: consentedBeliefs } = await consentedEngine.recordStatement({
        sessionId: s2,
        questionId: q2,
        rawText: "My daily routine starts at 6 AM.",
        now: NOW,
      });

      expect(consentedBeliefs).toHaveLength(1);
      expect(consentedBeliefs[0]!.categoryPolicy).toBe("opt_in");
    } finally {
      store.close();
    }
  });

  it("Restart and Reset Journeys", async () => {
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

      // Test Restart Session
      const { sessionId: s1, questionId: q1 } = await engine.startSession({
        sessionId: "sess_restart_old",
        now: NOW,
      });

      await engine.recordStatement({
        sessionId: s1,
        questionId: q1,
        rawText: "Initial statement",
        now: NOW,
      });

      const restartRes1 = await engine.restartSession(s1, NOW);
      expect(restartRes1.newSessionId).toBe("sess_restart_old_restarted");
      expect(host.state.sessions.get(s1)!.status).toBe("abandoned");
      expect(host.state.sessions.get(restartRes1.newSessionId)!.status).toBe("active");

      // Retrying restartSession returns existing restarted session
      const restartRes2 = await engine.restartSession(s1, NOW);
      expect(restartRes2.newSessionId).toBe(restartRes1.newSessionId);

      // Test Reset Session
      const resetRes = await engine.resetSession(restartRes1.newSessionId, NOW);
      expect(resetRes.questionId).toBe("q_sess_restart_old_restarted_1_reset_1");

      const resetSessionState = host.state.sessions.get(restartRes1.newSessionId)!;
      expect(resetSessionState.turns).toHaveLength(1);
      expect(resetSessionState.turns[0]!.questionId).toBe(resetRes.questionId);
      expect(resetSessionState.beliefs.size).toBe(0);
    } finally {
      store.close();
    }
  });

  it("State Transition Invariants and Command Preconditions", async () => {
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
          pattern: /project/i,
          proposals: [
            {
              subject: "project",
              claim: "Active project",
              category: "goals",
              temporalScope: "current",
              evidenceText: "project",
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
        sessionId: "sess_invariants_1",
        now: NOW,
      });

      const { proposedBeliefs } = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "I am working on my project.",
        now: NOW,
      });

      const b = proposedBeliefs[0]!;

      // Confirm belief
      await engine.confirmBelief({ sessionId, beliefId: b.beliefId, now: NOW });

      // Rejecting a confirmed belief is invalid and returns false
      const rejectConfirmed = await engine.rejectBelief({
        sessionId,
        beliefId: b.beliefId,
        now: NOW,
      });
      expect(rejectConfirmed).toBe(false);

      // Establish baseline
      await engine.establishBaseline({ sessionId, now: NOW });

      // After baseline establishment, confirm/correct/reject operations are rejected
      const confirmPostBase = await engine.confirmBelief({
        sessionId,
        beliefId: b.beliefId,
        now: NOW,
      });
      expect(confirmPostBase).toBe(false);

      await expect(
        engine.correctBelief({
          sessionId,
          oldBeliefId: b.beliefId,
          rawCorrectionText: "Correction text",
          correctedClaim: "New claim",
          correctedSubject: "new_subj",
          correctedCategory: "goals",
          now: NOW,
        }),
      ).rejects.toThrow();

      // Establishing baseline again on completed session is idempotent
      const baseAgain = await engine.establishBaseline({ sessionId, now: NOW });
      expect(baseAgain.confirmedBeliefIds).toEqual([b.beliefId]);

      // Establishing baseline on a paused session throws error
      const { sessionId: sPaused } = await engine.startSession({
        sessionId: "sess_paused_base",
        now: NOW,
      });
      await engine.skipSession(sPaused, NOW);
      await expect(engine.establishBaseline({ sessionId: sPaused, now: NOW })).rejects.toThrow();

      // Restarting or resetting a completed session throws error
      await expect(engine.restartSession(sessionId, NOW)).rejects.toThrow();
      await expect(engine.resetSession(sessionId, NOW)).rejects.toThrow();
    } finally {
      store.close();
    }
  });

  it("Narrows evidence provenance sourceEventIds to turns where evidenceText appears", () => {
    const request: ExtractionRequest = {
      currentQuestion: "Question 2",
      currentStatement: "I am focused on my career.",
      currentStatementEnvelopeId: "evt_stmt_turn2",
      priorTurns: [
        {
          question: "Question 1",
          statement: "My family is my top priority.",
          statementEnvelopeId: "evt_stmt_turn1",
        },
      ],
    };

    const careerSourceIds = determineSourceEventIds("career", request);
    expect(careerSourceIds).toEqual(["evt_stmt_turn2"]); // Only turn 2!

    const familySourceIds = determineSourceEventIds("family", request);
    expect(familySourceIds).toEqual(["evt_stmt_turn1"]); // Only turn 1!
  });
});
