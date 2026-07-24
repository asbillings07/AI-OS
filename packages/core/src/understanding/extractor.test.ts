import { describe, expect, it } from "vitest";
import {
  LlmBeliefExtractor,
  type LlmCompletionFunction,
} from "./extractor.js";
import {
  DeterministicPolicyGate,
  type ExtractionRequest,
} from "./onboarding.js";

const DEFAULT_POLICY_GATE = new DeterministicPolicyGate();
const ALL_CATEGORIES = DEFAULT_POLICY_GATE.getEligibleCategories();

describe("Candidate Belief Extraction from Natural Language (#71)", () => {
  it("Fixture 1: Direct Value Declaration", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      return JSON.stringify({
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
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

    const request: ExtractionRequest = {
      currentQuestion: "What is important to you?",
      currentStatement: "Family is central to my daily life.",
      currentStatementEnvelopeId: "evt_stmt_1",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const candidates = await extractor.extractCandidates(request);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.subject).toBe("family");
    expect(candidates[0]!.category).toBe("values");
    expect(candidates[0]!.temporalScope).toBe("durable");
    expect(candidates[0]!.confidence).toBe(0.95);
    expect(candidates[0]!.supportingEvidence[0]!.evidenceText).toBe("Family is central to my daily life.");
  });

  it("Fixture 2: Temporary Bounded Priority", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      return JSON.stringify({
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
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

    const request: ExtractionRequest = {
      currentQuestion: "What are you working on?",
      currentStatement: "I need to focus on completing the Q3 release this week.",
      currentStatementEnvelopeId: "evt_stmt_2",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const candidates = await extractor.extractCandidates(request);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.subject).toBe("q3_release");
    expect(candidates[0]!.category).toBe("priorities");
    expect(candidates[0]!.temporalScope).toBe("bounded");
  });

  it("Fixture 3: Multi-Belief Paragraph across distinct categories", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      return JSON.stringify({
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
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

    const statementText =
      "My family is central to me, I am focused on building Orion AI-OS startup, and I insist on working out every morning at 6 AM.";

    const request: ExtractionRequest = {
      currentQuestion: "Tell me about your priorities",
      currentStatement: statementText,
      currentStatementEnvelopeId: "evt_stmt_3",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const candidates = await extractor.extractCandidates(request);

    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.category)).toEqual(["values", "goals", "routines"]);
  });

  it("Fixture 4: Third-Party Mention (not a personal user belief)", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      // LLM correctly recognizes the statement is about someone else and returns empty candidates
      return JSON.stringify({
        candidates: [],
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

    const request: ExtractionRequest = {
      currentQuestion: "How do you prefer to communicate?",
      currentStatement: "My manager prefers Slack messages instead of email.",
      currentStatementEnvelopeId: "evt_stmt_4",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const candidates = await extractor.extractCandidates(request);

    expect(candidates).toHaveLength(0);
  });

  it("Fixture 5: Negated Statement (expressing lack of interest)", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      // LLM correctly avoids extracting a positive belief for a negated interest
      return JSON.stringify({
        candidates: [],
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

    const request: ExtractionRequest = {
      currentQuestion: "What tasks do you want to take on?",
      currentStatement: "I do not want to manage social media marketing campaigns.",
      currentStatementEnvelopeId: "evt_stmt_5",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const candidates = await extractor.extractCandidates(request);

    expect(candidates).toHaveLength(0);
  });

  it("Fixture 6: Ambiguous / Conversational Non-Belief Statement", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      return JSON.stringify({
        candidates: [],
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

    const request: ExtractionRequest = {
      currentQuestion: "Anything else?",
      currentStatement: "Yeah, it was an okay meeting I guess.",
      currentStatementEnvelopeId: "evt_stmt_6",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const candidates = await extractor.extractCandidates(request);

    expect(candidates).toHaveLength(0);
  });

  it("Fixture 7: Hallucinated / Non-Verbatim Evidence Span Rejection", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      return JSON.stringify({
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
                // HALLUCINATED TEXT: "marathon running" does NOT exist in the statement!
                evidenceText: "marathon running",
              },
            ],
            confidence: 0.9,
          },
        ],
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

    const request: ExtractionRequest = {
      currentQuestion: "What is your routine?",
      currentStatement: "I go for a short walk every evening.",
      currentStatementEnvelopeId: "evt_stmt_7",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const candidates = await extractor.extractCandidates(request);

    // Candidate rejected because evidence span "marathon running" is NOT verbatim in statement!
    expect(candidates).toHaveLength(0);
  });

  it("Fixture 8: Multi-Turn Evidence Lineage (referencing prior turn)", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      return JSON.stringify({
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
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

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

    const candidates = await extractor.extractCandidates(request);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.supportingEvidence[0]!.statementEnvelopeId).toBe("evt_stmt_prior_1");
    expect(candidates[0]!.supportingEvidence[0]!.evidenceText).toBe("building AI startup");
  });

  it("Fixture 9: Unconsented Category Filtering", async () => {
    const mockCompletion: LlmCompletionFunction = async () => {
      return JSON.stringify({
        candidates: [
          {
            subject: "routine",
            claim: "Morning routine at 6 AM",
            category: "routines", // Category 'routines' is excluded from eligibleCategories
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
      });
    };

    const extractor = new LlmBeliefExtractor({ completion: mockCompletion });

    const eligibleWithoutRoutines = new Set(ALL_CATEGORIES);
    eligibleWithoutRoutines.delete("routines");

    const request: ExtractionRequest = {
      currentQuestion: "What is your schedule?",
      currentStatement: "Morning routine at 6 AM.",
      currentStatementEnvelopeId: "evt_stmt_9",
      priorTurns: [],
      eligibleCategories: eligibleWithoutRoutines,
    };

    const candidates = await extractor.extractCandidates(request);

    // Filtered out because 'routines' is not in request.eligibleCategories
    expect(candidates).toHaveLength(0);
  });

  it("Fixture 10: Malformed JSON / Network Crash Graceful Recovery", async () => {
    // A. Network crash
    const throwingCompletion: LlmCompletionFunction = async () => {
      throw new Error("Simulated LLM API network timeout");
    };

    const extractor1 = new LlmBeliefExtractor({ completion: throwingCompletion });

    const request: ExtractionRequest = {
      currentQuestion: "What matters to you?",
      currentStatement: "Family is central to my daily life.",
      currentStatementEnvelopeId: "evt_stmt_10",
      priorTurns: [],
      eligibleCategories: ALL_CATEGORIES,
    };

    const res1 = await extractor1.extractCandidates(request);
    expect(res1).toEqual([]);

    // B. Malformed non-JSON output
    const malformedCompletion: LlmCompletionFunction = async () => {
      return "I cannot fulfill this request because of invalid markdown syntax ::: {";
    };

    const extractor2 = new LlmBeliefExtractor({ completion: malformedCompletion });
    const res2 = await extractor2.extractCandidates(request);
    expect(res2).toEqual([]);
  });
});
