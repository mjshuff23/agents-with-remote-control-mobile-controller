import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AppConfigModule } from '../config/app-config.module';
import { CheckpointsModule } from '../checkpoints/checkpoints.module';
import { EventsModule } from '../events/events.module';
import { PolicyModule } from '../policy/policy.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentSessionsService } from './agent-sessions.service';

/** NestJS module that provides the agent session lifecycle service. */
@Module({
  imports: [PrismaModule, AgentsModule, AppConfigModule, CheckpointsModule, EventsModule, ApprovalsModule, PolicyModule],
  providers: [AgentSessionsService],
  exports: [AgentSessionsService]
})
export class AgentSessionsModule {}
