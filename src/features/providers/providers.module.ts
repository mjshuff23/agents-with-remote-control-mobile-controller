import { Module } from '@nestjs/common';
import { IGitHubProvider } from './github-provider.interface';
import { ILinearProvider } from './linear-provider.interface';
import { MockGitHubProvider } from './mock-github-provider';
import { MockLinearProvider } from './mock-linear-provider';

@Module({
  providers: [
    { provide: IGitHubProvider, useClass: MockGitHubProvider },
    { provide: ILinearProvider, useClass: MockLinearProvider },
  ],
  exports: [IGitHubProvider, ILinearProvider],
})
export class ProvidersModule {}
