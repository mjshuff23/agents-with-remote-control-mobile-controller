-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SyncEvent" (
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyncEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SyncEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SyncEvent" ("action", "createdAt", "errorCategory", "errorMessage", "externalId", "id", "metadataJson", "provider", "sessionId", "status", "targetId", "taskId", "updatedAt", "url") SELECT "action", "createdAt", "errorCategory", "errorMessage", "externalId", "id", "metadataJson", "provider", "sessionId", "status", "targetId", "taskId", "updatedAt", "url" FROM "SyncEvent";
DROP TABLE "SyncEvent";
ALTER TABLE "new_SyncEvent" RENAME TO "SyncEvent";
CREATE INDEX "SyncEvent_taskId_idx" ON "SyncEvent"("taskId");
CREATE INDEX "SyncEvent_taskId_status_idx" ON "SyncEvent"("taskId", "status");
CREATE INDEX "SyncEvent_taskId_action_idx" ON "SyncEvent"("taskId", "action");
CREATE UNIQUE INDEX "SyncEvent_taskId_provider_targetId_action_key" ON "SyncEvent"("taskId", "provider", "targetId", "action");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
