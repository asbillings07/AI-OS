/**
 * Vertical slice script for Natural-language Onboarding Baseline (#70).
 *
 * Runs end-to-end onboarding session in terminal with zero external network dependencies:
 *   - Starts onboarding session
 *   - Records multi-turn user statements and asks follow-ups
 *   - Runs Policy Gate & Scripted Extractor to propose beliefs
 *   - Exercises confirmation, rejection, and user correction
 *   - Establishes baseline and formats summary
 *   - Demonstrates replay parity and privacy baseline deletion
 *
 *   npm run slice:onboarding
 */
import {
  InProcessEventBus,
  LlmBeliefExtractor,
  OnboardingEngine,
  OrionRuntime,
  ProjectionHost,
  SqliteEventStore,
  onboardingProjection,
} from "@orion/core";

const NOW = "2026-07-24T14:00:00.000Z";

async function main(): Promise<void> {
  console.log("================================================================================");
  console.log("ORION NATURAL-LANGUAGE ONBOARDING VERTICAL SLICE (#70 / #71)");
  console.log("================================================================================\n");

  const store = new SqliteEventStore(":memory:");
  try {
    const bus = new InProcessEventBus();
    const host = new ProjectionHost(onboardingProjection);
    const runtime = new OrionRuntime({
      bus,
      store,
      projections: [host as ProjectionHost<unknown>],
    });

    // Provider-neutral LlmBeliefExtractor with structured LLM completion
    const extractor = new LlmBeliefExtractor({
      completion: async (options) => {
        // Simulates structured LLM interpretation of the natural-language user statement
        return JSON.stringify({
          candidates: [
            {
              subject: "family",
              claim: "Family well-being",
              category: "values",
              temporalScope: "durable",
              evidenceText: "family",
              supportingEvidence: [
                {
                  statementEnvelopeId: "evt_stmt_stmt_session_demo_1_q_session_demo_1_1",
                  evidenceText: "family",
                },
              ],
              confidence: 0.95,
            },
            {
              subject: "career",
              claim: "Launching Orion AI-OS startup",
              category: "goals",
              temporalScope: "current",
              evidenceText: "career",
              supportingEvidence: [
                {
                  statementEnvelopeId: "evt_stmt_stmt_session_demo_1_q_session_demo_1_1",
                  evidenceText: "career",
                },
              ],
              confidence: 0.9,
            },
            {
              subject: "health",
              claim: "Protecting physical health and regular exercise",
              category: "priorities",
              temporalScope: "durable",
              evidenceText: "health",
              supportingEvidence: [
                {
                  statementEnvelopeId: "evt_stmt_stmt_session_demo_1_q_session_demo_1_1",
                  evidenceText: "health",
                },
              ],
              confidence: 0.85,
            },
          ],
        });
      },
    });

    const engine = new OnboardingEngine({
      runtime,
      extractor,
      getProjectionState: () => host.state,
    });

    // 1. Start session
    console.log("1. Starting First-Run Onboarding Session...");
    const { sessionId, questionId, questionText } = await engine.startSession({
      sessionId: "session_demo_1",
      now: NOW,
    });
    console.log(`   Session ID : ${sessionId}`);
    console.log(`   Orion Asked: "${questionText}" [${questionId}]\n`);

    // 2. User statement
    const userStatement =
      "My family is central to me, I am focused on my career, and protecting my health is critical.";
    console.log(`2. User Responds: "${userStatement}"`);

    const { proposedBeliefs } = await engine.recordStatement({
      sessionId,
      questionId,
      rawText: userStatement,
      now: NOW,
    });

    console.log(`   Extractor & Policy Gate Proposed ${proposedBeliefs.length} Candidate Beliefs:`);
    for (const belief of proposedBeliefs) {
      console.log(`     • [${belief.categoryPolicy}] ${belief.category.toUpperCase()}: ${belief.claim}`);
      console.log(`       Evidence: "${belief.evidenceText}" (confidence: ${belief.confidence})`);
    }
    console.log("");

    // 3. User actions: Confirm family & career, Correct health
    console.log("3. User Interacts with Proposals:");
    const familyBelief = proposedBeliefs.find((b) => b.subject === "family")!;
    const careerBelief = proposedBeliefs.find((b) => b.subject === "career")!;
    const healthBelief = proposedBeliefs.find((b) => b.subject === "health")!;

    await engine.confirmBelief({ sessionId, beliefId: familyBelief.beliefId, now: NOW });
    console.log(`   ✓ Confirmed: "${familyBelief.claim}"`);

    await engine.confirmBelief({ sessionId, beliefId: careerBelief.beliefId, now: NOW });
    console.log(`   ✓ Confirmed: "${careerBelief.claim}"`);

    const { newBeliefId } = await engine.correctBelief({
      sessionId,
      oldBeliefId: healthBelief.beliefId,
      rawCorrectionText: "I am specifically prioritizing strength training and 8 hours sleep.",
      correctedClaim: "Prioritizing strength training and 8 hours sleep",
      correctedSubject: "sleep_and_fitness",
      correctedCategory: "priorities",
      correctedTemporalScope: "current",
      now: NOW,
    });
    console.log(`   ✎ Corrected "${healthBelief.claim}" -> Replacement ID: ${newBeliefId}\n`);

    // 4. Establish baseline
    console.log("4. Establishing User Understanding Baseline...");
    const { summary } = await engine.establishBaseline({ sessionId, now: NOW });

    console.log("\n================================================================================");
    console.log("ESTABLISHED BASELINE SUMMARY:");
    console.log("================================================================================");
    for (const line of summary) {
      console.log(`  • ${line}`);
    }
    console.log("================================================================================\n");

    // 5. Verify Event Log Replay Parity
    console.log("5. Verifying Replay Parity Over Canonical Event Log...");
    console.log(`   Current Total Log Events: ${store.count()}`);

    const replayedHost = new ProjectionHost(onboardingProjection);
    const replayedRuntime = new OrionRuntime({
      bus: new InProcessEventBus(),
      store,
      projections: [replayedHost as ProjectionHost<unknown>],
    });
    await replayedRuntime.rebuild();

    const replayedSession = replayedHost.state.sessions.get(sessionId)!;
    console.log(`   Replayed Session Status : ${replayedSession.status}`);
    console.log(`   Replayed Baseline Exists: ${replayedSession.isBaselineEstablished}`);
    console.log(`   Replayed Summary Lines  : ${replayedSession.baselineSummary?.length}\n`);

    // 6. Privacy Baseline Deletion
    console.log("6. Exercising Privacy Baseline Deletion...");
    await engine.deleteBaseline(sessionId, "User requested baseline reset", NOW);

    const deletedState = host.state.sessions.get(sessionId)!;
    console.log(`   Is Baseline Deleted: ${deletedState.isBaselineDeleted}`);
    console.log(`   Active Baseline    : ${deletedState.isBaselineEstablished ? "ACTIVE" : "NONE (DELETED)"}\n`);

    console.log("Slice run completed successfully!");
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
