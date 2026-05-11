import { Module } from '@nestjs/common';
import { AgentSessionsModule } from '../agent-sessions/agent-sessions.module';
import { AppConfigModule } from '../config/app-config.module';
import { EventsModule } from '../events/events.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [PrismaModule, AgentSessionsModule, AppConfigModule, EventsModule],
  controllers: [TasksController],
  providers: [TasksService]
})
export class TasksModule {}
