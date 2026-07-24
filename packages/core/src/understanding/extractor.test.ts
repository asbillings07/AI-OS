import { createAi, type AiCapabilities } from "@orion/ai";
import { describe, expect, it } from "vitest";
import {
  InProcessEventBus,
  LlmBeliefExtractor,
  OnboardingEngine,
  OrionRuntime,
  ProjectionHost,
  SqliteEventStore,
  onboardingProjection,
  DeterministicPolicyGate,
  type ExtractionRequest,
} from "../index.js";

const DEFAULT_POLICY_GATE = new DeterministicPolicyGate();
const ALL_CATEGORIES = DEFAULT_POLICY_GATE.getEligibleCategories();
const NOW = "2026-07-24T14:00:00.000Z";

function createMockAi(
  extractFn: (request: any) => Promise<any>,
  options: { providerName?: string; modelName?: string } = {},
): AiCapabilities {
  const providerName = options.providerName ?? "mock-provider";
  const modelName = options.modelName ?? "mock-model";
  return createAi({
    provider: {
      name: providerName,
      modelName,
      summarize: async () => ({ summary: "", confidence: 0 }),
      classify: async () => ({ label: "", confidence: 0 }),
      extractBeliefs: async (req) => {
        const raw = await extractFn(req);
        return {
          candidates: raw.candidates ?? [],
          inferenceMechanism: `${providerName}:${modelName}`,
          promptSchemaVersion: "v0.1",
          modelName,
        };
      },
    },
  });
}

describe("Candidate Belief Extraction from Natural Language (#71)", () => {
  it("Fixture 1: Direct Value Declaration", async () => {
    const ai = createMockAi(async () => ({
      candidates: [
        {
          subject: "family",
          claim: "Family well-being is top priority",
          category: "values",
          temporalScope: "durable",
          evidenceText: "Family is central to my daily life.",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_1",
              evidenceText: "Family is central to my daily life.",
            },
          ],
          confidence: 0.95,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });

    const request: ExtractionRequest = {
      currentQuestion: "What is important to you?",
      currentStatement: "Family is central to my daily life.",
      currentStatementEnvelopeId: "evt_stmt_1",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.subject).toBe("family");
    expect(result.candidates[0]!.category).toBe("values");
    expect(result.candidates[0]!.temporalScope).toBe("durable");
    expect(result.candidates[0]!.confidence).toBe(0.95);
    expect(result.candidates[0]!.supportingEvidence[0]!.evidenceText).toBe("Family is central to my daily life.");
    expect(result.metadata.inferenceMechanism).toBe("mock-provider:mock-model");
  });

  it("Fixture 2: Temporary Bounded Priority", async () => {
    const ai = createMockAi(async () => ({
      candidates: [
        {
          subject: "q3_release",
          claim: "Focusing on completing the Q3 release this week",
          category: "priorities",
          temporalScope: "bounded",
          evidenceText: "I need to focus on completing the Q3 release this week.",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_2",
              evidenceText: "I need to focus on completing the Q3 release this week.",
            },
          ],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });

    const request: ExtractionRequest = {
      currentQuestion: "What are you working on?",
      currentStatement: "I need to focus on completing the Q3 release this week.",
      currentStatementEnvelopeId: "evt_stmt_2",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.subject).toBe("q3_release");
    expect(result.candidates[0]!.category).toBe("priorities");
    expect(result.candidates[0]!.temporalScope).toBe("bounded");
  });

  it("Fixture 3: Multi-Belief Paragraph across distinct categories", async () => {
    const ai = createMockAi(async () => ({
      candidates: [
        {
          subject: "family",
          claim: "Family well-being",
          category: "values",
          temporalScope: "durable",
          evidenceText: "My family is central to me",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_3",
              evidenceText: "My family is central to me",
            },
          ],
          confidence: 0.95,
        },
        {
          subject: "startup",
          claim: "Launching Orion AI-OS startup",
          category: "goals",
          temporalScope: "current",
          evidenceText: "building Orion AI-OS startup",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_3",
              evidenceText: "building Orion AI-OS startup",
            },
          ],
          confidence: 0.9,
        },
        {
          subject: "health",
          claim: "Working out every morning at 6 AM",
          category: "routines",
          temporalScope: "durable",
          evidenceText: "working out every morning at 6 AM",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_3",
              evidenceText: "working out every morning at 6 AM",
            },
          ],
          confidence: 0.85,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });

    const statementText =
      "My family is central to me, I am focused on building Orion AI-OS startup, and I insist on working out every morning at 6 AM.";

    const request: ExtractionRequest = {
      currentQuestion: "Tell me about your priorities",
      currentStatement: statementText,
      currentStatementEnvelopeId: "evt_stmt_3",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((c) => c.category)).toEqual(["values", "goals", "routines"]);
  });

  it("Fixture 4: Third-Party Mention (not a personal user belief)", async () => {
    const ai = createMockAi(async () => ({ candidates: [] }));
    const extractor = new LlmBeliefExtractor({ ai });

    const request: ExtractionRequest = {
      currentQuestion: "How do you prefer to communicate?",
      currentStatement: "My manager prefers Slack messages instead of email.",
      currentStatementEnvelopeId: "evt_stmt_4",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);
    expect(result.candidates).toHaveLength(0);
  });

  it("Fixture 5: Negated Statement (expressing lack of interest)", async () => {
    const ai = createMockAi(async () => ({ candidates: [] }));
    const extractor = new LlmBeliefExtractor({ ai });

    const request: ExtractionRequest = {
      currentQuestion: "What tasks do you want to take on?",
      currentStatement: "I do not want to manage social media marketing campaigns.",
      currentStatementEnvelopeId: "evt_stmt_5",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);
    expect(result.candidates).toHaveLength(0);
  });

  it("Fixture 6: Ambiguous / Conversational Non-Belief Statement", async () => {
    const ai = createMockAi(async () => ({ candidates: [] }));
    const extractor = new LlmBeliefExtractor({ ai });

    const request: ExtractionRequest = {
      currentQuestion: "Anything else?",
      currentStatement: "Yeah, it was an okay meeting I guess.",
      currentStatementEnvelopeId: "evt_stmt_6",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);
    expect(result.candidates).toHaveLength(0);
  });

  it("Fixture 7: Hallucinated / Non-Verbatim Evidence Span Rejection", async () => {
    const ai = createMockAi(async () => ({
      candidates: [
        {
          subject: "fitness",
          claim: "Loves marathon running",
          category: "routines",
          temporalScope: "durable",
          evidenceText: "Loves marathon running",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_7",
              evidenceText: "marathon running", // Hallucinated span
            },
          ],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });

    const request: ExtractionRequest = {
      currentQuestion: "What is your routine?",
      currentStatement: "I go for a short walk every evening.",
      currentStatementEnvelopeId: "evt_stmt_7",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);
    expect(result.candidates).toHaveLength(0);
  });

  it("Fixture 8: Multi-Turn Evidence Lineage (referencing prior turn)", async () => {
    const ai = createMockAi(async () => ({
      candidates: [
        {
          subject: "career_goal",
          claim: "Building AI startup",
          category: "goals",
          temporalScope: "current",
          evidenceText: "building AI startup",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_prior_1",
              evidenceText: "building AI startup",
            },
          ],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });

    const request: ExtractionRequest = {
      currentQuestion: "Tell me more about that startup goal.",
      currentStatement: "Yes, exactly as I said earlier.",
      currentStatementEnvelopeId: "evt_stmt_8",
      priorTurns: [
        {
          question: "What is your primary focus?",
          statement: "I am building AI startup called Orion.",
          statementEnvelopeId: "evt_stmt_prior_1",
        },
      ],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.supportingEvidence[0]!.statementEnvelopeId).toBe("evt_stmt_prior_1");
    expect(result.candidates[0]!.supportingEvidence[0]!.evidenceText).toBe("building AI startup");
  });

  it("Fixture 9: Unconsented Category Filtering", async () => {
    const ai = createMockAi(async () => ({
      candidates: [
        {
          subject: "routine",
          claim: "Morning routine at 6 AM",
          category: "routines",
          temporalScope: "durable",
          evidenceText: "Morning routine at 6 AM",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_9",
              evidenceText: "Morning routine at 6 AM",
            },
          ],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });

    const eligibleWithoutRoutines = new Set(ALL_CATEGORIES);
    eligibleWithoutRoutines.delete("routines");

    const request: ExtractionRequest = {
      currentQuestion: "What is your schedule?",
      currentStatement: "Morning routine at 6 AM.",
      currentStatementEnvelopeId: "evt_stmt_9",
      priorTurns: [],
      eligibleCategories: eligibleWithoutRoutines,
    };

    const result = await extractor.extractCandidates(request);
    expect(result.candidates).toHaveLength(0);
  });

  it("Fixture 10: Malformed Output / Error Graceful Recovery", async () => {
    const throwingAi = createAi({
      provider: {
        name: "failing-provider",
        summarize: async () => ({ summary: "", confidence: 0 }),
        classify: async () => ({ label: "", confidence: 0 }),
        extractBeliefs: async () => {
          throw new Error("Simulated LLM API network timeout");
        },
      },
    });

    const extractor = new LlmBeliefExtractor({ ai: throwingAi });

    const request: ExtractionRequest = {
      currentQuestion: "What matters to you?",
      currentStatement: "Family is central to my daily life.",
      currentStatementEnvelopeId: "evt_stmt_10",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);
    expect(result.candidates).toEqual([]);
    expect(result.metadata.inferenceMechanism).toBe("failing-provider");
  });

  it("Contract Check 2: Strict candidate validation drops malformed candidates without silent coercion", async () => {
    const ai = createMockAi(async () => ({
      candidates: [
        // Candidate A: Invalid temporalScope (e.g. "forever") -> REJECTED
        {
          subject: "career",
          claim: "Works in software",
          category: "roles_and_relationships",
          temporalScope: "forever",
          evidenceText: "software",
          supportingEvidence: [{ statementEnvelopeId: "evt_stmt_valid", evidenceText: "software" }],
          confidence: 0.9,
        },
        // Candidate B: Missing/invalid confidence -> REJECTED
        {
          subject: "career",
          claim: "Works in software",
          category: "roles_and_relationships",
          temporalScope: "durable",
          evidenceText: "software",
          supportingEvidence: [{ statementEnvelopeId: "evt_stmt_valid", evidenceText: "software" }],
          confidence: "super-high",
        },
        // Candidate C: Invalid category -> REJECTED
        {
          subject: "career",
          claim: "Works in software",
          category: "unknown_cat",
          temporalScope: "durable",
          evidenceText: "software",
          supportingEvidence: [{ statementEnvelopeId: "evt_stmt_valid", evidenceText: "software" }],
          confidence: 0.9,
        },
        // Candidate D: Completely valid -> ACCEPTED
        {
          subject: "career",
          claim: "Works in software",
          category: "roles_and_relationships",
          temporalScope: "durable",
          evidenceText: "software",
          supportingEvidence: [{ statementEnvelopeId: "evt_stmt_valid", evidenceText: "software" }],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });
    const request: ExtractionRequest = {
      currentQuestion: "What do you do?",
      currentStatement: "I work in software.",
      currentStatementEnvelopeId: "evt_stmt_valid",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.subject).toBe("career");
  });

  it("Contract Check 3: Rejects top-level evidence hallucination even when containing a small supporting span", async () => {
    const ai = createMockAi(async () => ({
      candidates: [
        {
          subject: "ethics",
          claim: "Values honesty",
          category: "values",
          temporalScope: "durable",
          // Hallucinated surrounding paragraph containing small valid span 'honesty'
          evidenceText: "I am a software engineer who deeply believes that honesty is essential in leadership.",
          supportingEvidence: [
            {
              statementEnvelopeId: "evt_stmt_hallucinated",
              evidenceText: "honesty",
            },
          ],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });
    const request: ExtractionRequest = {
      currentQuestion: "What is important to you?",
      currentStatement: "I value honesty.",
      currentStatementEnvelopeId: "evt_stmt_hallucinated",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const result = await extractor.extractCandidates(request);
    expect(result.candidates).toHaveLength(0);
  });

  it("Contract Check 4: Reject sensitive trait claims when evidence spans lack sensitive keywords (including mixed statements)", async () => {
    const ai = createMockAi(async (req) => ({
      candidates: [
        {
          subject: "health",
          claim: "I have cancer",
          category: "values",
          temporalScope: "durable",
          evidenceText: "I",
          supportingEvidence: [
            {
              statementEnvelopeId: req.currentStatementEnvelopeId,
              evidenceText: "I",
            },
          ],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });
    const gate = new DeterministicPolicyGate({ allowedCategories: ALL_CATEGORIES });

    // Case A: Pure non-sensitive statement
    const requestPure: ExtractionRequest = {
      currentQuestion: "How are you feeling?",
      currentStatement: "I like mornings.",
      currentStatementEnvelopeId: "evt_stmt_pure",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };
    const resultPure = await extractor.extractCandidates(requestPure);
    expect(resultPure.candidates).toHaveLength(1);
    expect(gate.validateCandidate(resultPure.candidates[0]!, requestPure).valid).toBe(false);

    // Case B: Mixed statement containing 'cancer' elsewhere, but candidate evidence span is only 'I'
    const requestMixed: ExtractionRequest = {
      currentQuestion: "How are you feeling?",
      currentStatement: "My friend has cancer; I like mornings.",
      currentStatementEnvelopeId: "evt_stmt_mixed",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };
    const resultMixed = await extractor.extractCandidates(requestMixed);
    expect(resultMixed.candidates).toHaveLength(1);
    expect(gate.validateCandidate(resultMixed.candidates[0]!, requestMixed).valid).toBe(false);
  });

  it("Contract Check 5: Policy-denied statement records empty processed snapshot and permits baseline establishment", async () => {
    const store = new SqliteEventStore(":memory:");
    const bus = new InProcessEventBus();
    const host = new ProjectionHost(onboardingProjection);
    const runtime = new OrionRuntime({ bus, store, projections: [host as ProjectionHost<unknown>] });

    const policyGate = new DeterministicPolicyGate({
      allowedCategories: ALL_CATEGORIES,
    });

    const ai = createMockAi(async () => ({ candidates: [] }));
    const extractor = new LlmBeliefExtractor({ ai });
    const engine = new OnboardingEngine({
      runtime,
      extractor,
      policyGate,
      getProjectionState: () => host.state,
    });

    const { sessionId, questionId } = await engine.startSession({ sessionId: "sess_denied_1", now: NOW });

    // Record a prohibited statement that policy denies prior to extraction
    const { statementEnvelopeId, proposedBeliefs } = await engine.recordStatement({
      sessionId,
      questionId,
      rawText: "This text contains explicit-pornography and is prohibited.",
      now: NOW,
    });

    expect(proposedBeliefs).toHaveLength(0);

    const session = host.state.sessions.get(sessionId)!;
    const turn = session.turns.find((t) => t.questionId === questionId)!;

    // Verify snapshot was persisted and turn is processed
    expect(turn.statementEnvelopeId).toBe(statementEnvelopeId);
    expect(turn.isStatementProcessed).toBe(true);
    expect(turn.extractionSnapshot).toEqual([]);

    // Baseline establishment succeeds because all statement turns are marked processed
    await expect(engine.establishBaseline({ sessionId, now: NOW })).resolves.not.toThrow();
    expect(host.state.sessions.get(sessionId)!.isBaselineEstablished).toBe(true);
  });

  it("Contract Check 6: Event log replay preserves provider/model metadata (modelName, inferenceMechanism, promptSchemaVersion)", async () => {
    const store = new SqliteEventStore(":memory:");
    const bus = new InProcessEventBus();
    const host = new ProjectionHost(onboardingProjection);
    const runtime = new OrionRuntime({ bus, store, projections: [host as ProjectionHost<unknown>] });

    const policyGate = new DeterministicPolicyGate({
      allowedCategories: new Set(["values"]),
    });

    const ai = createMockAi(
      async (req) => ({
        candidates: [
          {
            subject: "family",
            claim: "Family is top priority",
            category: "values",
            temporalScope: "durable",
            evidenceText: "Family is top priority",
            supportingEvidence: [{ statementEnvelopeId: req.currentStatementEnvelopeId, evidenceText: "Family is top priority" }],
            confidence: 0.95,
          },
        ],
      }),
      { providerName: "openai-provider", modelName: "gpt-4o" },
    );

    const extractor = new LlmBeliefExtractor({ ai });
    const engine = new OnboardingEngine({
      runtime,
      extractor,
      policyGate,
      getProjectionState: () => host.state,
    });

    const { sessionId, questionId } = await engine.startSession({ sessionId: "sess_replay_meta", now: NOW });
    await engine.recordStatement({
      sessionId,
      questionId,
      rawText: "Family is top priority for me.",
      now: NOW,
    });

    const originalSession = host.state.sessions.get(sessionId)!;
    const originalTurn = originalSession.turns.find((t) => t.questionId === questionId)!;
    expect(originalTurn.modelName).toBe("gpt-4o");
    expect(originalTurn.inferenceMechanism).toBe("openai-provider:gpt-4o");
    expect(originalTurn.promptSchemaVersion).toBe("v0.1");

    // Replay events into a new ProjectionHost
    const replayedHost = new ProjectionHost(onboardingProjection);
    const events = store.readAll();
    for (const envelope of events) {
      replayedHost.handle(envelope);
    }

    const replayedSession = replayedHost.state.sessions.get(sessionId)!;
    const replayedTurn = replayedSession.turns.find((t) => t.questionId === questionId)!;
    expect(replayedTurn.modelName).toBe("gpt-4o");
    expect(replayedTurn.inferenceMechanism).toBe("openai-provider:gpt-4o");
    expect(replayedTurn.promptSchemaVersion).toBe("v0.1");

    const replayedBelief = Array.from(replayedSession.beliefs.values())[0]!;
    expect(replayedBelief.claim).toBe("Family is top priority");
  });

  it("Contract Check 7: Reject sensitive claims attributed to third parties even when verbatim evidence is returned", async () => {
    const store = new SqliteEventStore(":memory:");
    const bus = new InProcessEventBus();
    const host = new ProjectionHost(onboardingProjection);
    const runtime = new OrionRuntime({ bus, store, projections: [host as ProjectionHost<unknown>] });

    const policyGate = new DeterministicPolicyGate({
      allowedCategories: ALL_CATEGORIES,
    });

    const ai = createMockAi(async (req) => ({
      candidates: [
        {
          subject: "health",
          claim: "I have cancer",
          category: "values",
          temporalScope: "durable",
          evidenceText: "My friend has cancer",
          supportingEvidence: [
            {
              statementEnvelopeId: req.currentStatementEnvelopeId,
              evidenceText: "My friend has cancer",
            },
          ],
          confidence: 0.95,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });
    const engine = new OnboardingEngine({
      runtime,
      extractor,
      policyGate,
      getProjectionState: () => host.state,
    });

    const { sessionId, questionId } = await engine.startSession({ sessionId: "sess_third_party_sensitive", now: NOW });
    const { proposedBeliefs } = await engine.recordStatement({
      sessionId,
      questionId,
      rawText: "My friend has cancer.",
      now: NOW,
    });

    // The proposal must be rejected by the DeterministicPolicyGate because the sensitive evidence attributes the trait to 'friend', not the user
    expect(proposedBeliefs).toHaveLength(0);
    const session = host.state.sessions.get(sessionId)!;
    expect(session.beliefs.size).toBe(0);
  });

  it("Contract Check 8: Reject sensitive trait claims attributed to named individuals (e.g. Sam, John) without relying on a finite noun list", async () => {
    const store = new SqliteEventStore(":memory:");
    const bus = new InProcessEventBus();
    const host = new ProjectionHost(onboardingProjection);
    const runtime = new OrionRuntime({ bus, store, projections: [host as ProjectionHost<unknown>] });

    const policyGate = new DeterministicPolicyGate({
      allowedCategories: ALL_CATEGORIES,
    });

    const ai = createMockAi(async (req) => ({
      candidates: [
        {
          subject: "health",
          claim: "I have cancer",
          category: "values",
          temporalScope: "durable",
          evidenceText: "Sam has cancer",
          supportingEvidence: [
            {
              statementEnvelopeId: req.currentStatementEnvelopeId,
              evidenceText: "Sam has cancer",
            },
          ],
          confidence: 0.95,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });
    const engine = new OnboardingEngine({
      runtime,
      extractor,
      policyGate,
      getProjectionState: () => host.state,
    });

    const { sessionId, questionId } = await engine.startSession({ sessionId: "sess_named_sensitive", now: NOW });
    const { proposedBeliefs } = await engine.recordStatement({
      sessionId,
      questionId,
      rawText: "Sam has cancer.",
      now: NOW,
    });

    // The proposal must be rejected by the DeterministicPolicyGate because 'Sam' is a named third party, not the user
    expect(proposedBeliefs).toHaveLength(0);
    const session = host.state.sessions.get(sessionId)!;
    expect(session.beliefs.size).toBe(0);
  });

  it("Acceptance Case: User correction of an earlier statement produces corrected belief candidate", async () => {
    const store = new SqliteEventStore(":memory:");
    const bus = new InProcessEventBus();
    const host = new ProjectionHost(onboardingProjection);
    const runtime = new OrionRuntime({ bus, store, projections: [host as ProjectionHost<unknown>] });

    const policyGate = new DeterministicPolicyGate({
      allowedCategories: new Set(["roles_and_relationships"]),
    });

    const ai = createMockAi(async (req) => {
      if (req.priorTurns.length === 0) {
        return {
          candidates: [
            {
              subject: "role",
              claim: "Frontend architect",
              category: "roles_and_relationships",
              temporalScope: "durable",
              evidenceText: "frontend architect",
              supportingEvidence: [{ statementEnvelopeId: req.currentStatementEnvelopeId, evidenceText: "frontend architect" }],
              confidence: 0.9,
            },
          ],
        };
      }
      return {
        candidates: [
          {
            subject: "role",
            claim: "Engineering manager",
            category: "roles_and_relationships",
            temporalScope: "durable",
            evidenceText: "I am an engineering manager",
            supportingEvidence: [{ statementEnvelopeId: req.currentStatementEnvelopeId, evidenceText: "I am an engineering manager" }],
            confidence: 0.95,
          },
        ],
      };
    });

    const extractor = new LlmBeliefExtractor({ ai });
    const engine = new OnboardingEngine({
      runtime,
      extractor,
      policyGate,
      getProjectionState: () => host.state,
    });

    const { sessionId, questionId: q1 } = await engine.startSession({ sessionId: "sess_corr_1", now: NOW });
    const res1 = await engine.recordStatement({
      sessionId,
      questionId: q1,
      rawText: "I work as a frontend architect.",
      now: NOW,
    });

    expect(res1.proposedBeliefs).toHaveLength(1);
    expect(res1.proposedBeliefs[0]!.claim).toBe("Frontend architect");

    // Turn 2: Follow up with correction
    const { questionId: q2 } = await engine.askFollowUp({
      sessionId,
      questionText: "Any updates to your role?",
      now: NOW,
    });

    const res2 = await engine.recordStatement({
      sessionId,
      questionId: q2,
      rawText: "Correction: I am an engineering manager, not a frontend architect.",
      now: NOW,
    });

    expect(res2.proposedBeliefs).toHaveLength(1);
    expect(res2.proposedBeliefs[0]!.claim).toBe("Engineering manager");
    expect(res2.proposedBeliefs[0]!.sourceEventIds).toEqual([res2.statementEnvelopeId]);

    const state = host.state;
    const session = state.sessions.get(sessionId)!;
    // Both beliefs remain recorded as unconfirmed proposals for user review
    expect(session.beliefs.size).toBe(2);
    const beliefs = Array.from(session.beliefs.values());
    expect(beliefs.map((b) => b.claim)).toEqual(["Frontend architect", "Engineering manager"]);
    expect(beliefs.every((b) => b.verification === "unconfirmed" && b.status === "proposed")).toBe(true);
  });

  it("Acceptance Case: Conflicting candidate proposals in a turn are recorded as proposals without mutating baseline", async () => {
    const store = new SqliteEventStore(":memory:");
    const bus = new InProcessEventBus();
    const host = new ProjectionHost(onboardingProjection);
    const runtime = new OrionRuntime({ bus, store, projections: [host as ProjectionHost<unknown>] });

    const policyGate = new DeterministicPolicyGate({
      allowedCategories: new Set(["constraints"]),
    });

    const ai = createMockAi(async (req) => ({
      candidates: [
        {
          subject: "location",
          claim: "Prefers fully remote work",
          category: "constraints",
          temporalScope: "current",
          evidenceText: "fully remote work",
          supportingEvidence: [{ statementEnvelopeId: req.currentStatementEnvelopeId, evidenceText: "fully remote work" }],
          confidence: 0.9,
        },
        {
          subject: "location",
          claim: "Prefers in-office working",
          category: "constraints",
          temporalScope: "current",
          evidenceText: "in-office working",
          supportingEvidence: [{ statementEnvelopeId: req.currentStatementEnvelopeId, evidenceText: "in-office working" }],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });
    const engine = new OnboardingEngine({
      runtime,
      extractor,
      policyGate,
      getProjectionState: () => host.state,
    });

    const { sessionId, questionId } = await engine.startSession({ sessionId: "sess_conflict_1", now: NOW });
    await engine.recordStatement({
      sessionId,
      questionId,
      rawText: "I want fully remote work, but I also enjoy in-office working.",
      now: NOW,
    });

    const state = host.state;
    const session = state.sessions.get(sessionId)!;
    expect(session.beliefs.size).toBe(2);
    // Baseline is not yet established, so active understanding is protected
    expect(session.isBaselineEstablished).toBe(false);
  });

  it("Acceptance Case: Rejection of proposal leaves baseline User Understanding protected", async () => {
    const store = new SqliteEventStore(":memory:");
    const bus = new InProcessEventBus();
    const host = new ProjectionHost(onboardingProjection);
    const runtime = new OrionRuntime({ bus, store, projections: [host as ProjectionHost<unknown>] });

    const policyGate = new DeterministicPolicyGate({
      allowedCategories: new Set(["constraints"]),
    });

    const ai = createMockAi(async (req) => ({
      candidates: [
        {
          subject: "workload",
          claim: "Wants 80 hour work week",
          category: "constraints",
          temporalScope: "bounded",
          evidenceText: "80 hour work week",
          supportingEvidence: [{ statementEnvelopeId: req.currentStatementEnvelopeId, evidenceText: "80 hour work week" }],
          confidence: 0.9,
        },
      ],
    }));

    const extractor = new LlmBeliefExtractor({ ai });
    const engine = new OnboardingEngine({
      runtime,
      extractor,
      policyGate,
      getProjectionState: () => host.state,
    });

    const { sessionId, questionId } = await engine.startSession({ sessionId: "sess_reject_1", now: NOW });
    const { proposedBeliefs } = await engine.recordStatement({
      sessionId,
      questionId,
      rawText: "Someone suggested an 80 hour work week.",
      now: NOW,
    });

    expect(proposedBeliefs).toHaveLength(1);
    const beliefId = proposedBeliefs[0]!.beliefId;

    // Explicitly reject the proposal
    await engine.rejectBelief({
      sessionId,
      beliefId,
      reason: "Incorrect interpretation",
      now: NOW,
    });

    // Establish baseline
    await engine.establishBaseline({ sessionId, now: NOW });

    const state = host.state;
    const session = state.sessions.get(sessionId)!;
    expect(session.isBaselineEstablished).toBe(true);
    // Baseline contains zero confirmed beliefs because the proposal was rejected
    expect(session.baselineConfirmedBeliefIds).toEqual([]);
  });
});
