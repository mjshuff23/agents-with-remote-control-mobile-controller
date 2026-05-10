import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { EventsGateway } from './events.gateway';

@Module({
  imports: [AppConfigModule],
  providers: [EventsGateway],
  exports: [EventsGateway]
})
export class EventsModule {}
