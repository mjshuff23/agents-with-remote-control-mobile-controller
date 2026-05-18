-- CreateTable
CREATE TABLE "McpAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "sessionId" TEXT,
    "approvalRequestId" TEXT,
    "serverId" TEXT NOT NULL,
    "serverDisplayName" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "permissionLevel" TEXT,
    "toolRisk" TEXT,
    "decider" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "argumentHash" TEXT NOT NULL,
    "resultHash" TEXT,
    "sanitizedArgumentPreview" TEXT NOT NULL,
    "sanitizedResultPreview" TEXT,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "errorCategory" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpAuditLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "McpAuditLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "McpAuditLog_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "McpAuditLog_taskId_createdAt_idx" ON "McpAuditLog"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "McpAuditLog_sessionId_createdAt_idx" ON "McpAuditLog"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "McpAuditLog_approvalRequestId_idx" ON "McpAuditLog"("approvalRequestId");

-- CreateIndex
CREATE INDEX "McpAuditLog_serverId_toolName_createdAt_idx" ON "McpAuditLog"("serverId", "toolName", "createdAt");

-- CreateIndex
CREATE INDEX "McpAuditLog_outcome_createdAt_idx" ON "McpAuditLog"("outcome", "createdAt");
