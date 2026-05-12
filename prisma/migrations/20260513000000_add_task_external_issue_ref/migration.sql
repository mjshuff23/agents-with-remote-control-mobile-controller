-- Add externalIssueRef column to Task for Phase 4 issue-linked task creation
ALTER TABLE "Task" ADD COLUMN "externalIssueRef" TEXT;
