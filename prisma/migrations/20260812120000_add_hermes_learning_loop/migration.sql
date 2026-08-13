-- Additive Hermes learning-loop tables. No existing marketplace or warehouse table
-- is changed, copied, or dropped by this migration.
CREATE TABLE "HermesAnalysisMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "periodDays" INTEGER NOT NULL,
    "sourceMode" TEXT NOT NULL,
    "qualityStatus" TEXT NOT NULL,
    "skillId" TEXT,
    "skillVersion" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "contextJson" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "analysisJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HermesAnalysisMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HermesAnalysisFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HermesAnalysisFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HermesAnalysisFeedback_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "HermesAnalysisMemory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HermesRecommendationAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "recommendationIndex" INTEGER NOT NULL,
    "actionText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "metricKey" TEXT,
    "windowDays" INTEGER,
    "baselineValue" REAL,
    "targetValue" REAL,
    "unit" TEXT,
    "notes" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HermesRecommendationAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HermesRecommendationAction_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "HermesAnalysisMemory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HermesRecommendationEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "windowStartDate" TEXT,
    "windowEndDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_READY',
    "baselineValue" REAL,
    "targetValue" REAL,
    "actualValue" REAL,
    "deltaValue" REAL,
    "verdict" TEXT,
    "evidenceJson" TEXT,
    "effectivePeriodJson" TEXT,
    "notes" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HermesRecommendationEvaluation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HermesRecommendationEvaluation_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "HermesRecommendationAction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HermesAnalysisFeedback_analysisId_userId_key" ON "HermesAnalysisFeedback"("analysisId", "userId");
CREATE UNIQUE INDEX "HermesRecommendationAction_analysisId_recommendationIndex_key" ON "HermesRecommendationAction"("analysisId", "recommendationIndex");
CREATE UNIQUE INDEX "HermesRecommendationEvaluation_actionId_windowDays_key" ON "HermesRecommendationEvaluation"("actionId", "windowDays");
CREATE INDEX "HermesAnalysisMemory_userId_createdAt_idx" ON "HermesAnalysisMemory"("userId", "createdAt");
CREATE INDEX "HermesAnalysisMemory_userId_storeId_intent_createdAt_idx" ON "HermesAnalysisMemory"("userId", "storeId", "intent", "createdAt");
CREATE INDEX "HermesAnalysisFeedback_userId_createdAt_idx" ON "HermesAnalysisFeedback"("userId", "createdAt");
CREATE INDEX "HermesRecommendationAction_userId_status_idx" ON "HermesRecommendationAction"("userId", "status");
CREATE INDEX "HermesRecommendationAction_userId_completedAt_idx" ON "HermesRecommendationAction"("userId", "completedAt");
CREATE INDEX "HermesRecommendationEvaluation_userId_status_idx" ON "HermesRecommendationEvaluation"("userId", "status");
