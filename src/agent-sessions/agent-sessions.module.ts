import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AppConfigModule } from '../config/app-config.module';
import { EventsModule } from '../events/events.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentSessionsService } from './agent-sessions.service';

@Module({
  imports: [PrismaModule, AgentsModule, AppConfigModule, EventsModule],
  providers: [AgentSessionsService],
  exports: [AgentSessionsService]
})
export class AgentSessionsModule {}
