import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { PolicyModule } from '../policy/policy.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TestRunnerService } from './test-runner.service';

@Module({
  imports: [PrismaModule, PolicyModule, EventsModule],
  providers: [TestRunnerService],
  exports: [TestRunnerService]
})
export class TestRunnerModule {}
