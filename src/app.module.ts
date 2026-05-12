import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/app-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { EventsModule } from './events/events.module';
import { AgentsModule } from './agents/agents.module';
import { AgentSessionsModule } from './agent-sessions/agent-sessions.module';
import { TasksModule } from './tasks/tasks.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { GitModule } from './git/git.module';
import { PolicyModule } from './policy/policy.module';
import { AuditLogModule } from './audit/audit-log.module';
import { TestRunnerModule } from './test-runs/test-runner.module';

/** Root application module importing all feature modules. */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    EventsModule,
    AgentsModule,
    AgentSessionsModule,
    TasksModule,
    ApprovalsModule,
    GitModule,
    PolicyModule,
    AuditLogModule,
    TestRunnerModule
  ]
})
export class AppModule {}
