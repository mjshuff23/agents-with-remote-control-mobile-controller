import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit/audit-log.module';
import { AppConfigModule } from '../../config/app-config.module';
import { EventsModule } from '../../events/events.module';
import { PolicyModule } from '../policy/policy.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ApprovalsService } from './approvals.service';

/** NestJS module that provides the approval lifecycle service. */
@Module({
  imports: [PrismaModule, PolicyModule, AuditLogModule, AppConfigModule, EventsModule],
  providers: [ApprovalsService],
  exports: [ApprovalsService]
})
export class ApprovalsModule {}
