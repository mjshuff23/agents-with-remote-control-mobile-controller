-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "sessionId" TEXT,
    "provider" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "externalId" TEXT,
    "url" TEXT,
    "errorCategory" TEXT,
    "errorMessage" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncEvent_taskId_provider_targetId_action_key" ON "SyncEvent"("taskId", "provider", "targetId", "action");

-- CreateIndex
CREATE INDEX "SyncEvent_taskId_idx" ON "SyncEvent"("taskId");

-- CreateIndex
CREATE INDEX "SyncEvent_taskId_status_idx" ON "SyncEvent"("taskId", "status");

-- CreateIndex
CREATE INDEX "SyncEvent_taskId_action_idx" ON "SyncEvent"("taskId", "action");
