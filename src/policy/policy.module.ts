import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { ActionClassifierService } from './action-classifier.service';
import { PolicyLoaderService } from './policy-loader.service';

@Module({
  imports: [AppConfigModule],
  providers: [PolicyLoaderService, ActionClassifierService],
  exports: [PolicyLoaderService, ActionClassifierService]
})
export class PolicyModule {}
