import { Module } from '@nestjs/common';

import { AppConfigModule } from '../config/app-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsGateway } from './events.gateway';
import { TaskEventLedgerService } from './task-event-ledger.service';

/** NestJS module that provides the WebSocket gateway and event ledger service. */
@Module({
  imports: [AppConfigModule, PrismaModule],
  providers: [EventsGateway, TaskEventLedgerService],
  exports: [EventsGateway, TaskEventLedgerService]
})
export class EventsModule {}
