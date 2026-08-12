-- Additive learning-loop metadata: prompt/output versions, feedback reasons,
-- stable recommendation IDs, and explicit period comparability.
ALTER TABLE "HermesAnalysisMemory" ADD COLUMN "promptVersion" TEXT NOT NULL DEFAULT '1.1.0';
ALTER TABLE "HermesAnalysisMemory" ADD COLUMN "outputSchemaVersion" TEXT NOT NULL DEFAULT '1.0';
ALTER TABLE "HermesAnalysisFeedback" ADD COLUMN "reasonsJson" TEXT;
ALTER TABLE "HermesRecommendationAction" ADD COLUMN "recommendationId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HermesRecommendationAction" ADD COLUMN "baselinePeriodStartDate" TEXT;
ALTER TABLE "HermesRecommendationAction" ADD COLUMN "baselinePeriodEndDate" TEXT;
ALTER TABLE "HermesRecommendationEvaluation" ADD COLUMN "periodStatus" TEXT NOT NULL DEFAULT 'NOT_CHECKED';

UPDATE "HermesRecommendationAction"
SET "recommendationId" = 'rec-' || CAST("recommendationIndex" + 1 AS TEXT)
WHERE "recommendationId" = '';

CREATE UNIQUE INDEX "HermesRecommendationAction_analysisId_recommendationId_key"
ON "HermesRecommendationAction"("analysisId", "recommendationId");
