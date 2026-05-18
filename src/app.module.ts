import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/app-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { EventsModule } from './events/events.module';
import { AgentsModule } from './agents/agents.module';
import { AgentSessionsModule } from './features/agent-sessions/agent-sessions.module';
import { CheckpointsModule } from './features/checkpoints/checkpoints.module';
import { TasksModule } from './features/tasks/tasks.module';
import { ApprovalsModule } from './features/approvals/approvals.module';
import { WorktreesModule } from './features/worktrees/worktrees.module';
import { PolicyModule } from './features/policy/policy.module';
import { AuditLogModule } from './features/audit/audit-log.module';
import { TestRunnerModule } from './features/test-runs/test-runner.module';
import { ProvidersModule } from './features/providers/providers.module';
import { SyncModule } from './features/sync/sync.module';
import { IntegrationsModule } from './features/integrations/integrations.module';
import { McpModule } from './mcp/mcp.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    EventsModule,
    AgentsModule,
    AgentSessionsModule,
    CheckpointsModule,
    TasksModule,
    ApprovalsModule,
    WorktreesModule,
    PolicyModule,
    AuditLogModule,
    TestRunnerModule,
    ProvidersModule,
    SyncModule,
    IntegrationsModule,
    McpModule
  ]
})
export class AppModule {}
