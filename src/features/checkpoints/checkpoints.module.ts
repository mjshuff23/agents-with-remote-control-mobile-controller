import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AppConfigModule } from '../../config/app-config.module';
import { EventsModule } from '../../events/events.module';
import { AuditLogModule } from '../audit/audit-log.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import { CheckpointsService } from './checkpoints.service';

@Module({
  imports: [PrismaModule, AppConfigModule, EventsModule, AuditLogModule, WorktreesModule],
  providers: [CheckpointsService],
  exports: [CheckpointsService]
})
export class CheckpointsModule {}
