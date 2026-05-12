import { Module } from '@nestjs/common';
import { INTEGRATION_GATEWAYS } from '../mcp-gateway/integration-gateway.interface';
import { GithubAdapter } from './github.adapter';

@Module({
  providers: [GithubAdapter, { provide: INTEGRATION_GATEWAYS, useFactory: (a: GithubAdapter) => [a], multi: true, inject: [GithubAdapter] }],
  exports: [INTEGRATION_GATEWAYS]
} as any)  // eslint-disable-line @typescript-eslint/no-explicit-any
export class GithubIntegrationModule {}
