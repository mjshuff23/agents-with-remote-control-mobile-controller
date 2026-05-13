import { Module } from '@nestjs/common';

import { AgentSessionsModule } from '../agent-sessions/agent-sessions.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AppConfigModule } from '../../config/app-config.module';
import { ControllerSecretGuard } from '../../common/guards/controller-secret.guard';
import { EventsModule } from '../../events/events.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import { PolicyModule } from '../policy/policy.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { TestRunnerModule } from '../test-runs/test-runner.module';
import { GitCommitService } from '../worktrees/git-commit.service';
import { ApprovalActionsController } from './approval-actions.controller';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/** NestJS module that wires task endpoints, services, and their dependencies. */
@Module({
  imports: [PrismaModule, AgentSessionsModule, AppConfigModule, EventsModule, WorktreesModule, ApprovalsModule, PolicyModule, TestRunnerModule, SyncModule],
  controllers: [TasksController, ApprovalActionsController],
  providers: [TasksService, ControllerSecretGuard, GitCommitService]
})
export class TasksModule {}
