import type {
  BeliefCategory,
  BeliefTemporalScope,
  CandidateBeliefProposal,
} from "../domain/index.js";
import type {
  BeliefExtractor,
  ExtractionRequest,
} from "./onboarding.js";

// ============================================================================
// 1. LLM Extractor Contracts & System Prompt
// ============================================================================

export type LlmCompletionFunction = (options: {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}) => Promise<string>;

export interface LlmBeliefExtractorOptions {
  readonly completion: LlmCompletionFunction;
  readonly promptSchemaVersion?: string;
  readonly mechanismVersion?: string;
}

export const SYSTEM_PROMPT_V01 = `You are an expert natural language analyzer for Orion, an AI Operating System.
Your task is to analyze a user's statement during a conversation and extract structured candidate beliefs about what matters to the user.

RULES:
1. ONLY extract beliefs explicitly stated or directly implied by the user's words.
2. DO NOT invent, assume, or hallucinate beliefs or evidence not present in the input text.
3. Every item in supportingEvidence MUST contain an evidenceText string that is an EXACT, VERBATIM substring of the user's statement text.
4. Categorize beliefs strictly into eligible categories: [values, roles_and_relationships, goals, priorities, constraints, routines].
5. Do NOT extract beliefs for categories not listed in eligible categories.
6. Temporal scope must be one of: [durable, current, bounded, unknown].
   - "durable": Core values, long-term relationships, or enduring principles.
   - "current": Active ongoing goals or current working focus.
   - "bounded": Time-bound priorities or temporary constraints.
   - "unknown": Temporal scope cannot be confidently determined.
7. Assign confidence between 0.0 and 1.0 based on clarity and directness.
8. If the statement expresses no clear personal beliefs, or if the user is speaking strictly about third parties or expressing negations without positive belief, return an empty list of candidates [].

OUTPUT FORMAT:
Return strictly a JSON object with a "candidates" key containing an array of objects:
{
  "candidates": [
    {
      "subject": "short_subject_identifier",
      "claim": "Clear summary claim of the belief",
      "category": "category_name",
      "temporalScope": "durable" | "current" | "bounded" | "unknown",
      "evidenceText": "Top-level evidence snippet from statement",
      "supportingEvidence": [
        {
          "statementEnvelopeId": "target_envelope_id",
          "evidenceText": "VERBATIM text snippet from target statement"
        }
      ],
      "confidence": 0.9
    }
  ]
}`;

// ============================================================================
// 2. Production LlmBeliefExtractor Implementation
// ============================================================================

export class LlmBeliefExtractor implements BeliefExtractor {
  readonly #completion: LlmCompletionFunction;
  readonly promptSchemaVersion: string;
  readonly mechanismVersion: string;

  constructor(options: LlmBeliefExtractorOptions) {
    this.#completion = options.completion;
    this.promptSchemaVersion = options.promptSchemaVersion ?? "v0.1";
    this.mechanismVersion = options.mechanismVersion ?? "v0.1-llm";
  }

  async extractCandidates(request: ExtractionRequest): Promise<readonly CandidateBeliefProposal[]> {
    if (request.eligibleCategories.size === 0) {
      return [];
    }

    const currentText = request.currentStatement.trim();
    if (!currentText) {
      return [];
    }

    const priorTurnsPayload = request.priorTurns.map((turn) => ({
      question: turn.question,
      statement: turn.statement,
      statementEnvelopeId: turn.statementEnvelopeId,
    }));

    const userPromptPayload = {
      currentQuestion: request.currentQuestion,
      currentStatement: currentText,
      currentStatementEnvelopeId: request.currentStatementEnvelopeId,
      priorTurns: priorTurnsPayload,
      eligibleCategories: Array.from(request.eligibleCategories),
    };

    const userPrompt = JSON.stringify(userPromptPayload, null, 2);

    let rawResponse: string;
    try {
      rawResponse = await this.#completion({
        systemPrompt: SYSTEM_PROMPT_V01,
        userPrompt,
      });
    } catch {
      // Extraction failures leave original statement intact and do not block conversation
      return [];
    }

    return this.parseAndValidateResponse(rawResponse, request);
  }

  private parseAndValidateResponse(
    rawResponse: string,
    request: ExtractionRequest,
  ): readonly CandidateBeliefProposal[] {
    let parsed: unknown;
    try {
      const cleanJson = rawResponse
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      parsed = JSON.parse(cleanJson);
    } catch {
      return [];
    }

    if (!parsed || typeof parsed !== "object") {
      return [];
    }

    const obj = parsed as Record<string, unknown>;
    const rawCandidates = Array.isArray(obj.candidates) ? obj.candidates : [];

    const validatedCandidates: CandidateBeliefProposal[] = [];

    for (const raw of rawCandidates) {
      if (!raw || typeof raw !== "object") continue;

      const candidate = raw as Record<string, unknown>;

      const subject = typeof candidate.subject === "string" ? candidate.subject.trim() : "";
      const claim = typeof candidate.claim === "string" ? candidate.claim.trim() : "";
      const category = candidate.category as BeliefCategory;
      const temporalScopeRaw = candidate.temporalScope as string;

      let temporalScope: BeliefTemporalScope = "unknown";
      if (
        temporalScopeRaw === "durable" ||
        temporalScopeRaw === "current" ||
        temporalScopeRaw === "bounded" ||
        temporalScopeRaw === "unknown"
      ) {
        temporalScope = temporalScopeRaw;
      }

      const evidenceText =
        typeof candidate.evidenceText === "string" ? candidate.evidenceText.trim() : "";

      const rawConfidence = Number(candidate.confidence);
      const confidence =
        !isNaN(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
          ? rawConfidence
          : 0.8;

      if (!subject || !claim || !category || !evidenceText) {
        continue;
      }

      if (!request.eligibleCategories.has(category)) {
        continue;
      }

      const rawSupporting = Array.isArray(candidate.supportingEvidence)
        ? candidate.supportingEvidence
        : [];

      const supportingEvidence: { statementEnvelopeId: string; evidenceText: string }[] = [];
      let isEvidenceValid = true;

      for (const sup of rawSupporting) {
        if (!sup || typeof sup !== "object") {
          isEvidenceValid = false;
          break;
        }

        const supObj = sup as Record<string, unknown>;
        const envId =
          typeof supObj.statementEnvelopeId === "string"
            ? supObj.statementEnvelopeId.trim()
            : "";
        const spanText =
          typeof supObj.evidenceText === "string" ? supObj.evidenceText.trim() : "";

        if (!envId || !spanText) {
          isEvidenceValid = false;
          break;
        }

        // Top-level evidenceText must contain the supporting evidence span
        if (!evidenceText.includes(spanText)) {
          isEvidenceValid = false;
          break;
        }

        // Verbatim check against target statement text
        let targetStatementText: string | undefined;
        if (envId === request.currentStatementEnvelopeId) {
          targetStatementText = request.currentStatement;
        } else {
          const matchingTurn = request.priorTurns.find(
            (t) => t.statementEnvelopeId === envId,
          );
          if (matchingTurn) {
            targetStatementText = matchingTurn.statement;
          }
        }

        if (!targetStatementText || !targetStatementText.includes(spanText)) {
          isEvidenceValid = false;
          break;
        }

        supportingEvidence.push({
          statementEnvelopeId: envId,
          evidenceText: spanText,
        });
      }

      if (!isEvidenceValid || supportingEvidence.length === 0) {
        continue;
      }

      validatedCandidates.push({
        subject,
        claim,
        category,
        temporalScope,
        evidenceText,
        supportingEvidence,
        confidence,
      });
    }

    return validatedCandidates;
  }
}
