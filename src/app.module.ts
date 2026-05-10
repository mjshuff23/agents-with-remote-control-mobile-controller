import { Module } from '@nestjs/common';
import { AgentSessionsModule } from './agent-sessions/agent-sessions.module';
import { AgentsModule } from './agents/agents.module';
import { AppConfigModule } from './config/app-config.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AgentsModule,
    AgentSessionsModule,
    TasksModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
