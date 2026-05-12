import { Module } from '@nestjs/common';
import { INTEGRATION_GATEWAYS } from '../mcp-gateway/integration-gateway.interface';
import { NotionAdapter } from './notion.adapter';

@Module({
  providers: [NotionAdapter, { provide: INTEGRATION_GATEWAYS, useFactory: (a: NotionAdapter) => [a], multi: true, inject: [NotionAdapter] }],
  exports: [INTEGRATION_GATEWAYS]
} as any)  // eslint-disable-line @typescript-eslint/no-explicit-any
export class NotionIntegrationModule {}
