import { Module } from '@nestjs/common';
import { AgentSessionsModule } from '../agent-sessions/agent-sessions.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AppConfigModule } from '../config/app-config.module';
import { EventsModule } from '../events/events.module';
import { GitModule } from '../git/git.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TestRunnerModule } from '../test-runs/test-runner.module';
import { ApprovalActionsController } from './approval-actions.controller';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [PrismaModule, AgentSessionsModule, AppConfigModule, EventsModule, GitModule, ApprovalsModule, TestRunnerModule],
  controllers: [TasksController, ApprovalActionsController],
  providers: [TasksService]
})
export class TasksModule {}
