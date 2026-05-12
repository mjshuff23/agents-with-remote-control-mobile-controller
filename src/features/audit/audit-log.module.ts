import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AuditLogService } from './audit-log.service';

/** NestJS module that provides the audit logging service. */
@Module({
  imports: [PrismaModule],
  providers: [AuditLogService],
  exports: [AuditLogService]
})
export class AuditLogModule {}
