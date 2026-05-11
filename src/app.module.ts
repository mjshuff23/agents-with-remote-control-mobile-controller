import { Module } from '@nestjs/common';
import { AgentSessionsModule } from './agent-sessions/agent-sessions.module';
import { AgentsModule } from './agents/agents.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { AuditLogModule } from './audit/audit-log.module';
import { AppConfigModule } from './config/app-config.module';
import { EventsModule } from './events/events.module';
import { GitModule } from './git/git.module';
import { HealthController } from './health.controller';
import { PolicyModule } from './policy/policy.module';
import { PrismaModule } from './prisma/prisma.module';
import { TasksModule } from './tasks/tasks.module';
import { TestRunnerModule } from './test-runs/test-runner.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AgentsModule,
    AuditLogModule,
    PolicyModule,
    ApprovalsModule,
    GitModule,
    TestRunnerModule,
    AgentSessionsModule,
    EventsModule,
    TasksModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
