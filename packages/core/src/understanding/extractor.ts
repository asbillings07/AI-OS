import type { AiCapabilities } from "@orion/ai";
import type {
  BeliefCategory,
  BeliefTemporalScope,
  CandidateBeliefProposal,
} from "../domain/index.js";
import type {
  BeliefExtractor,
  ExtractionRequest,
  ExtractionResult,
} from "./onboarding.js";

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "values",
  "roles_and_relationships",
  "goals",
  "priorities",
  "constraints",
  "routines",
]);

const VALID_TEMPORAL_SCOPES: ReadonlySet<string> = new Set([
  "durable",
  "current",
  "bounded",
  "unknown",
]);

export interface LlmBeliefExtractorOptions {
  readonly ai: AiCapabilities;
  readonly promptSchemaVersion?: string;
}

export class LlmBeliefExtractor implements BeliefExtractor {
  readonly #ai: AiCapabilities;
  readonly promptSchemaVersion: string;

  constructor(options: LlmBeliefExtractorOptions) {
    this.#ai = options.ai;
    this.promptSchemaVersion = options.promptSchemaVersion ?? "v0.1";
  }

  async extractCandidates(request: ExtractionRequest): Promise<ExtractionResult> {
    const defaultMetadata = {
      inferenceMechanism: this.#ai.providerName,
      promptSchemaVersion: this.promptSchemaVersion,
    };

    if (request.eligibleCategories.size === 0) {
      return { candidates: [], metadata: defaultMetadata };
    }

    const currentText = request.currentStatement.trim();
    if (!currentText) {
      return { candidates: [], metadata: defaultMetadata };
    }

    const priorTurnsPayload = request.priorTurns.map((turn) => ({
      question: turn.question,
      statement: turn.statement,
      statementEnvelopeId: turn.statementEnvelopeId,
    }));

    try {
      const result = await this.#ai.extractBeliefs({
        currentQuestion: request.currentQuestion,
        currentStatement: currentText,
        currentStatementEnvelopeId: request.currentStatementEnvelopeId,
        priorTurns: priorTurnsPayload,
        eligibleCategories: Array.from(request.eligibleCategories),
      });

      const metadata = {
        inferenceMechanism: result.inferenceMechanism ?? this.#ai.providerName,
        promptSchemaVersion: result.promptSchemaVersion ?? this.promptSchemaVersion,
        modelName: result.modelName,
      };

      const validatedCandidates = this.validateRawCandidates(result.candidates, request);

      return {
        candidates: validatedCandidates,
        metadata,
      };
    } catch {
      // Extraction failures leave original statement intact and return empty candidates
      return { candidates: [], metadata: defaultMetadata };
    }
  }

  private validateRawCandidates(
    rawCandidates: readonly unknown[],
    request: ExtractionRequest,
  ): readonly CandidateBeliefProposal[] {
    if (!Array.isArray(rawCandidates)) {
      return [];
    }

    const validated: CandidateBeliefProposal[] = [];

    for (const raw of rawCandidates) {
      if (!raw || typeof raw !== "object") continue;

      const candidate = raw as Record<string, unknown>;

      // Strict check: subject must be non-empty string
      if (typeof candidate.subject !== "string" || candidate.subject.trim().length === 0) {
        continue;
      }
      const subject = candidate.subject.trim();

      // Strict check: claim must be non-empty string
      if (typeof candidate.claim !== "string" || candidate.claim.trim().length === 0) {
        continue;
      }
      const claim = candidate.claim.trim();

      // Strict check: category must be valid BeliefCategory and in eligibleCategories
      if (typeof candidate.category !== "string" || !VALID_CATEGORIES.has(candidate.category)) {
        continue;
      }
      const category = candidate.category as BeliefCategory;
      if (!request.eligibleCategories.has(category)) {
        continue;
      }

      // Strict check: temporalScope must strictly match allowed values (no silent coercion)
      if (typeof candidate.temporalScope !== "string" || !VALID_TEMPORAL_SCOPES.has(candidate.temporalScope)) {
        continue;
      }
      const temporalScope = candidate.temporalScope as BeliefTemporalScope;

      // Strict check: confidence must be number between 0 and 1 (no silent default)
      if (typeof candidate.confidence !== "number" || isNaN(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
        continue;
      }
      const confidence = candidate.confidence;

      // Strict check: evidenceText must be non-empty string
      if (typeof candidate.evidenceText !== "string" || candidate.evidenceText.trim().length === 0) {
        continue;
      }
      const topLevelEvidence = candidate.evidenceText.trim();

      // Strict check: supportingEvidence must be non-empty array
      if (!Array.isArray(candidate.supportingEvidence) || candidate.supportingEvidence.length === 0) {
        continue;
      }

      const supportingEvidence: { statementEnvelopeId: string; evidenceText: string }[] = [];
      const targetStatementTexts: string[] = [];
      let isEvidenceValid = true;

      for (const sup of candidate.supportingEvidence) {
        if (!sup || typeof sup !== "object") {
          isEvidenceValid = false;
          break;
        }

        const supObj = sup as Record<string, unknown>;
        if (typeof supObj.statementEnvelopeId !== "string" || supObj.statementEnvelopeId.trim().length === 0) {
          isEvidenceValid = false;
          break;
        }
        if (typeof supObj.evidenceText !== "string" || supObj.evidenceText.trim().length === 0) {
          isEvidenceValid = false;
          break;
        }

        const envId = supObj.statementEnvelopeId.trim();
        const spanText = supObj.evidenceText.trim();

        // Top-level evidenceText must contain the supporting evidence span
        if (!topLevelEvidence.includes(spanText)) {
          isEvidenceValid = false;
          break;
        }

        // Look up target statement text for this envelope ID
        let targetStatementText: string | undefined;
        if (envId === request.currentStatementEnvelopeId) {
          targetStatementText = request.currentStatement;
        } else {
          const matchingTurn = request.priorTurns.find((t) => t.statementEnvelopeId === envId);
          if (matchingTurn) {
            targetStatementText = matchingTurn.statement;
          }
        }

        // Verbatim check: spanText MUST be in targetStatementText
        if (!targetStatementText || !targetStatementText.includes(spanText)) {
          isEvidenceValid = false;
          break;
        }

        targetStatementTexts.push(targetStatementText);
        supportingEvidence.push({ statementEnvelopeId: envId, evidenceText: spanText });
      }

      if (!isEvidenceValid || supportingEvidence.length === 0) {
        continue;
      }

      // Verbatim check for top-level evidenceText: topLevelEvidence MUST be a verbatim substring
      // of at least one of the referenced target statement texts (prevents hallucinated top-level evidence)
      const topLevelGrounded = targetStatementTexts.some((text) => text.includes(topLevelEvidence));
      if (!topLevelGrounded) {
        continue;
      }

      validated.push({
        subject,
        claim,
        category,
        temporalScope,
        evidenceText: topLevelEvidence,
        supportingEvidence,
        confidence,
      });
    }

    return validated;
  }
}
