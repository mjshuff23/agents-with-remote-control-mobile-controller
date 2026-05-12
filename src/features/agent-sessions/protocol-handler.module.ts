import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config/app-config.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { PolicyModule } from '../policy/policy.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProtocolHandlerService } from './protocol-handler.service';

@Module({
  imports: [PrismaModule, ApprovalsModule, AppConfigModule, PolicyModule],
  providers: [ProtocolHandlerService],
  exports: [ProtocolHandlerService]
})
export class ProtocolHandlerModule {}
