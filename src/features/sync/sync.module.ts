import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SyncEventService } from './sync-event.service';

@Module({
  imports: [PrismaModule],
  providers: [SyncEventService],
  exports: [SyncEventService],
})
export class SyncModule {}
