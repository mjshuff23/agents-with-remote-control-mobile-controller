-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "selectedAgent" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "externalSessionId" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "exitCode" INTEGER,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentSession_taskId_idx" ON "AgentSession"("taskId");

-- CreateIndex
CREATE INDEX "AgentSession_status_idx" ON "AgentSession"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentLog_sessionId_sequence_key" ON "AgentLog"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "AgentLog_sessionId_sequence_idx" ON "AgentLog"("sessionId", "sequence");
