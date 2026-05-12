-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN "dormantAt" DATETIME;
ALTER TABLE "AgentSession" ADD COLUMN "dormantReason" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "lastUserActivityAt" DATETIME;
ALTER TABLE "AgentSession" ADD COLUMN "lastWorkerActivityAt" DATETIME;

-- CreateTable
CREATE TABLE "SessionCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "lifecycleState" TEXT NOT NULL,
    "durableEventCursor" INTEGER NOT NULL,
    "lastUserActivityAt" DATETIME,
    "lastWorkerActivityAt" DATETIME,
    "workerWasLive" BOOLEAN NOT NULL DEFAULT false,
    "launchMetadataJson" TEXT NOT NULL,
    "frontierJson" TEXT NOT NULL,
    "lastUserMessage" TEXT,
    "lastAssistantMessage" TEXT,
    "recentTurnsJson" TEXT,
    "pendingApprovalIdsJson" TEXT,
    "pendingCriticalApproval" BOOLEAN NOT NULL DEFAULT false,
    "worktreePath" TEXT,
    "branchName" TEXT,
    "baseCommitSha" TEXT,
    "currentHeadSha" TEXT,
    "repoRoot" TEXT,
    "latestDiffSummaryId" TEXT,
    "latestTestSummaryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionCheckpoint_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionCheckpoint_sessionId_createdAt_idx" ON "SessionCheckpoint"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionCheckpoint_taskId_idx" ON "SessionCheckpoint"("taskId");
