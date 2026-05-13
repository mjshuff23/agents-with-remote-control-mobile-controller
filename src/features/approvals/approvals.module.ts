import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit/audit-log.module';
import { AppConfigModule } from '../../config/app-config.module';
import { EventsModule } from '../../events/events.module';
import { PolicyModule } from '../policy/policy.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { ApprovalsService } from './approvals.service';
import { ApprovalAuditSyncService } from './approval-audit-sync.service';
import { TimelineController } from './timeline.controller';

/** NestJS module that provides the approval lifecycle service. */
@Module({
  imports: [PrismaModule, PolicyModule, AuditLogModule, AppConfigModule, EventsModule, SyncModule],
  providers: [ApprovalsService, ApprovalAuditSyncService],
  controllers: [TimelineController],
  exports: [ApprovalsService, ApprovalAuditSyncService]
})
export class ApprovalsModule {}
