import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "../bus/index.js";
import { ProjectionHost } from "../projection/index.js";
import { OrionRuntime } from "../runtime/index.js";
import { SqliteEventStore } from "../store/index.js";
import {
  DeterministicPolicyGate,
  OnboardingEngine,
  ScriptedBeliefExtractor,
  onboardingProjection,
  type CandidateBeliefProposal,
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
      const { questionId: q2, text: followUpText } = await engine.askFollowUp({
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

  it("Fixture Journey 3: Ambiguous answer 'I don't know right now' produces NO belief", async () => {
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
      expect(sessionState.turns[0]!.statementId).toBe("stmt_sess_ambig_1_q_sess_ambig_1_1");
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

  it("Fixture Journey 5: Session controls, Retry idempotency, Privacy baseline deletion, and Replay", async () => {
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

      // Test skip & resume
      await engine.skipSession(sessionId, NOW);
      expect(host.state.sessions.get(sessionId)!.status).toBe("paused");

      await engine.resumeSession(sessionId, NOW);
      expect(host.state.sessions.get(sessionId)!.status).toBe("active");

      // Retry statement recording idempotency
      const res1 = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "I spend most of my time writing code.",
        now: NOW,
      });

      // Retrying recordStatement with same arguments should be idempotent
      const res2 = await engine.recordStatement({
        sessionId,
        questionId,
        rawText: "I spend most of my time writing code.",
        now: NOW,
      });

      expect(res1.statementId).toBe(res2.statementId);
      expect(res1.proposedBeliefs).toHaveLength(1);

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

      // Test Replay parity without re-running extractor
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

  it("Two-stage policy gate drops prohibited categories/keywords and validates evidence substring", () => {
    const gate = new DeterministicPolicyGate({
      prohibitedCategories: new Set(["routines"]),
    });

    const req = {
      currentQuestion: "What is important to you?",
      currentStatement: "I love reading books in the evening.",
      currentStatementEnvelopeId: "evt_1",
      priorTurns: [],
    };

    const prohibitedCandidate: CandidateBeliefProposal = {
      subject: "reading",
      claim: "Reading routines",
      category: "routines",
      temporalScope: "current",
      evidenceText: "reading books",
      confidence: 0.9,
    };

    expect(gate.validateCandidate(prohibitedCandidate, req).valid).toBe(false);

    const invalidEvidenceCandidate: CandidateBeliefProposal = {
      subject: "sports",
      claim: "Playing soccer",
      category: "priorities",
      temporalScope: "current",
      evidenceText: "playing soccer on weekends", // Not in statement!
      confidence: 0.9,
    };

    expect(gate.validateCandidate(invalidEvidenceCandidate, req).valid).toBe(false);

    const validCandidate: CandidateBeliefProposal = {
      subject: "books",
      claim: "Reading books",
      category: "values",
      temporalScope: "durable",
      evidenceText: "reading books",
      confidence: 0.9,
    };

    expect(gate.validateCandidate(validCandidate, req).valid).toBe(true);
  });
});
