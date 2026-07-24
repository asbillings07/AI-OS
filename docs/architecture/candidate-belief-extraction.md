# Candidate Belief Extraction Architecture

> Status: Draft · Owner: @asbillings07 · Last updated: 2026-07-24
> Related issues: #71 Extract candidate beliefs from natural-language conversations · Epic #69 · ADR-0005, ADR-0011, ADR-0016

The **Candidate Belief Extractor** is the provider-neutral natural-language interpretation boundary in Orion's Context Engine. Its job is to interpret user language from natural-language conversations (such as onboarding check-ins or ongoing chat) and produce structured, grounded `CandidateBeliefProposal` objects.

It strictly adheres to **ADR-0004** (*AI recommends, rules decide*), **ADR-0011** (*AI Abstraction Layer*), and **ADR-0016** (*User Understanding as Evidence-Backed Evolving Beliefs*):
- The extractor **proposes** candidate beliefs; it never directly mutates active user state.
- Every proposed belief must be **verbatim-grounded** in explicit user statement evidence.
- The extractor is provider-agnostic, structured, and resilient to malformed outputs or AI hallucination.

---

## Orientation in the Architecture

```text
User Natural-Language Statement / Turn
                 │
                 ▼
     [ UserStatementRecorded Event ]
                 │
                 ▼
  ┌─────────────────────────────────────┐
  │      BeliefExtractor Port           │
  │  (ScriptedBeliefExtractor or        │
  │   LlmBeliefExtractor)               │
  └──────────────────┬──────────────────┘
                     │ CandidateBeliefProposal[]
                     ▼
  ┌─────────────────────────────────────┐
  │     DeterministicPolicyGate         │
  │  - Stage 1: Pre-extraction consent  │
  │  - Stage 2: Verbatim evidence check │
  │    & sensitive category policy      │
  └──────────────────┬──────────────────┘
                     │ ValidatedCandidateProposal[]
                     ▼
     [ UserStatementProcessed Event ]
                 │
                 ▼
      [ UserBeliefProposed Events ]
```

---

## Core Contracts & Interfaces

The extractor implements the `BeliefExtractor` interface from `@orion/core`:

```ts
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
  readonly supportingEvidence: readonly {
    readonly statementEnvelopeId: string;
    readonly evidenceText: string;
  }[];
  readonly confidence: number;
}

export interface BeliefExtractor {
  extractCandidates(request: ExtractionRequest): Promise<readonly CandidateBeliefProposal[]>;
}
```

---

## Domain Vocabulary & Taxonomies

Candidate beliefs produced by the LLM extractor are constrained to the taxonomies approved in **ADR-0016**:

### 1. Categories (`BeliefCategory`)
- `values`: Core personal and professional principles and convictions (e.g., *"Family well-being"*, *"Work-life balance"*).
- `roles_and_relationships`: Professional roles, team structures, key relationships, or reporting lines (e.g., *"Engineering Lead for Orion"*, *"Mentoring junior engineers"*).
- `goals`: Specific outcomes or objectives being actively pursued (e.g., *"Launch AI-OS startup"*, *"Run a marathon"*).
- `priorities`: Relative importance and focus allocations across active goals or topics (e.g., *"Prioritizing code quality over fast iteration"*).
- `constraints`: Operational boundaries, schedule limits, or hard capacity constraints (e.g., *"No meetings after 5 PM"*, *"Available 30 hours per week"*).
- `routines`: Stated or observed behavioral patterns and schedules (e.g., *"Daily workout at 6 AM"*, *"Weekly planning on Mondays"*).

### 2. Temporal Scopes (`BeliefTemporalScope`)
- `durable`: Core values, long-term relationships, or enduring principles.
- `current`: Active ongoing goals or current working focus.
- `bounded`: Time-bound priorities or temporary constraints (e.g., *"Focusing on Q3 release this month"*).
- `unknown`: Temporal scope cannot be confidently determined.

---

## Extraction Requirements & Safety Rules

### 1. Grounded Evidence & Verification
- **Verbatim Evidence Requirement**: The extractor must return exact, verbatim text spans for `evidenceText` and `supportingEvidence.evidenceText` as they appear in `currentStatement` or `priorTurns`.
- **Hallucination Rejection**: Before a candidate proposal is accepted into the domain, `DeterministicPolicyGate` validates that every evidence text span in `supportingEvidence` is a literal substring of the target statement. Any unevidenced or hallucinated span causes the candidate to be safely dropped.

### 2. Grounding in Personal Belief
- **Third-Party Statements**: Statements purely about external people (e.g., *"My manager likes morning meetings"*) must either be classified under `roles_and_relationships` (if describing a relational constraint) or omitted if not a personal belief.
- **Negation**: Negated statements (*"I don't care about social media marketing"*) must **never** be extracted as positive beliefs (*"Values social media marketing"*).
- **Hypotheticals and Sarcasm**: Hypotheticals (*"If I were rich, I'd buy a boat"*) or sarcastic remarks must yield no proposal or be assigned low confidence (< 0.5).

### 3. Fault Tolerance & Non-Blocking Execution
- **Graceful Failure**: If the LLM returns malformed JSON, invalid schema properties, or network errors occur, `LlmBeliefExtractor` catches the exception, logs structured observability data, and returns an empty candidate list (`[]`).
- The original statement remains durable on the log as a `UserStatementRecorded` event and conversation flow continues unimpeded.

---

## LLM System Prompt & Output Schema

The `LlmBeliefExtractor` uses a versioned system prompt (`v0.1`) that enforces structured JSON output matching `CandidateBeliefProposal`.

### System Prompt Structure (v0.1)

```text
You are an expert natural language analyzer for Orion, an AI Operating System.
Your task is to analyze a user's statement during a conversation and extract structured candidate beliefs about what matters to the user.

RULES:
1. ONLY extract beliefs explicitly stated or directly implied by the user's words.
2. DO NOT invent, assume, or hallucinate beliefs or evidence not present in the input text.
3. Every item in supportingEvidence MUST contain an evidenceText string that is an EXACT, VERBATIM substring of the user's statement text.
4. Categorize beliefs strictly into eligible categories: [values, roles_and_relationships, goals, priorities, constraints, routines].
5. Do NOT extract beliefs for categories not listed in eligible categories.
6. Temporal scope must be one of: [durable, current, bounded, unknown].
7. Assign confidence between 0.0 and 1.0 based on clarity and directness.
8. If the statement expresses no clear personal beliefs, return an empty list of candidates [].
```

---

## Test Fixture Scenarios (Definition of Done)

The implementation will be verified against 10 explicit test fixture scenarios:

1. **Direct Value Declaration**: Rich statement expressing core family and career principles.
2. **Temporary Bounded Priority**: Time-limited project focus (*"Focusing on Q3 release this week"*).
3. **Multi-Belief Paragraph**: Single user statement containing 3+ distinct beliefs across categories.
4. **Third-Party Mention**: Statement about another person (*"Sam prefers Slack messages"*) correctly filtered or scoped.
5. **Negated Statement**: Statement expressing lack of interest (*"I do not want to manage people"*) handled correctly without positive belief extraction.
6. **Ambiguous Statement**: Vague or conversational statement (*"It was okay I guess"*) yielding 0 candidates.
7. **Hallucinated Evidence Span**: Model returning non-verbatim evidence text safely rejected by policy gate validation.
8. **Multi-Turn Evidence Lineage**: Supporting evidence referencing a prior turn in the conversation.
9. **Unconsented Category Attempt**: Model attempting to extract a category excluded from `eligibleCategories`, correctly filtered.
10. **Malformed JSON / Network Crash**: Provider error or invalid JSON response handled gracefully without throwing or blocking onboarding.

---

## Next Steps for Implementation (#71)

1. Implement `LlmBeliefExtractor` in `packages/core/src/understanding/extractor.ts` using a provider-neutral completion function or mockable adapter.
2. Add structured JSON response parsing and verbatim substring validation.
3. Write comprehensive unit test suite in `packages/core/src/understanding/extractor.test.ts`.
4. Connect `LlmBeliefExtractor` into `scripts/slice-onboarding.ts` for end-to-end slice verification.
