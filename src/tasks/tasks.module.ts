import { Module } from '@nestjs/common';
import { AgentSessionsModule } from '../agent-sessions/agent-sessions.module';
import { AppConfigModule } from '../config/app-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [AgentSessionsModule, AppConfigModule, PrismaModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService]
})
export class TasksModule {}
