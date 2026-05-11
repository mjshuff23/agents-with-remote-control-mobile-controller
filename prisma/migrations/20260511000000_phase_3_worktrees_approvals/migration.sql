-- AlterTable
ALTER TABLE "Task" ADD COLUMN "worktreePath" TEXT;
ALTER TABLE "Task" ADD COLUMN "branchName" TEXT;
ALTER TABLE "Task" ADD COLUMN "baseRef" TEXT;
ALTER TABLE "Task" ADD COLUMN "baseCommit" TEXT;
ALTER TABLE "Task" ADD COLUMN "approvalMode" TEXT NOT NULL DEFAULT 'cooperative-gated';

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "sessionId" TEXT,
    "actionRequestId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT,
    "commandJson" TEXT,
    "filesJson" TEXT,
    "expectedEffect" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ruleMatched" TEXT,
    "decision" TEXT,
    "decisionMessage" TEXT,
    "correlationId" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApprovalRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApprovalRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "sessionId" TEXT,
    "approvalRequestId" TEXT,
    "kind" TEXT NOT NULL,
    "actionType" TEXT,
    "riskLevel" TEXT,
    "ruleMatched" TEXT,
    "decision" TEXT,
    "message" TEXT NOT NULL,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GitChangeSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "sessionId" TEXT,
    "statusText" TEXT NOT NULL,
    "filesChanged" INTEGER NOT NULL DEFAULT 0,
    "insertions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "addedCount" INTEGER NOT NULL DEFAULT 0,
    "modifiedCount" INTEGER NOT NULL DEFAULT 0,
    "deletedCount" INTEGER NOT NULL DEFAULT 0,
    "renamedCount" INTEGER NOT NULL DEFAULT 0,
    "riskFlagsJson" TEXT NOT NULL DEFAULT '[]',
    "topFilesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GitChangeSummary_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GitChangeSummary_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestRunSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "sessionId" TEXT,
    "commandId" TEXT NOT NULL,
    "commandJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "exitCode" INTEGER,
    "highlightsJson" TEXT NOT NULL DEFAULT '[]',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TestRunSummary_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TestRunSummary_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_taskId_actionRequestId_key" ON "ApprovalRequest"("taskId", "actionRequestId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_taskId_status_idx" ON "ApprovalRequest"("taskId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_sessionId_idx" ON "ApprovalRequest"("sessionId");

-- CreateIndex
CREATE INDEX "AuditLog_taskId_createdAt_idx" ON "AuditLog"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_sessionId_createdAt_idx" ON "AuditLog"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_approvalRequestId_idx" ON "AuditLog"("approvalRequestId");

-- CreateIndex
CREATE INDEX "GitChangeSummary_taskId_createdAt_idx" ON "GitChangeSummary"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "GitChangeSummary_sessionId_createdAt_idx" ON "GitChangeSummary"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "TestRunSummary_taskId_createdAt_idx" ON "TestRunSummary"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TestRunSummary_sessionId_createdAt_idx" ON "TestRunSummary"("sessionId", "createdAt");
