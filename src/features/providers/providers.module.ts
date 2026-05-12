import { Module } from '@nestjs/common';
import { IGitHubProvider } from './github-provider.interface';
import { ILinearProvider } from './linear-provider.interface';
import { GitHubProvider } from './github-provider';
import { LinearProvider } from './linear-provider';
import { MockLinearProvider } from './mock-linear-provider';
import { AppConfigModule } from '../../config/app-config.module';
import { AppConfigService } from '../../config/app-config.service';

@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: IGitHubProvider,
      useFactory: (config: AppConfigService) => new GitHubProvider(config),
      inject: [AppConfigService],
    },
    {
      provide: ILinearProvider,
      useFactory: (config: AppConfigService) =>
        config.linearToken ? new LinearProvider(config) : new MockLinearProvider(),
      inject: [AppConfigService],
    },
  ],
  exports: [IGitHubProvider, ILinearProvider],
})
export class ProvidersModule {}
