import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AppConfigModule } from '../config/app-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentSessionsService } from './agent-sessions.service';

@Module({
  imports: [AgentsModule, AppConfigModule, PrismaModule],
  providers: [AgentSessionsService],
  exports: [AgentSessionsService]
})
export class AgentSessionsModule {}
