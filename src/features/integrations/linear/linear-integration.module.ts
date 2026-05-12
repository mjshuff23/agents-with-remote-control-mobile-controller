import { Module } from '@nestjs/common';
import { INTEGRATION_GATEWAYS } from '../mcp-gateway/integration-gateway.interface';
import { LinearAdapter } from './linear.adapter';

@Module({
  providers: [LinearAdapter, { provide: INTEGRATION_GATEWAYS, useFactory: (a: LinearAdapter) => [a], multi: true, inject: [LinearAdapter] }],
  exports: [INTEGRATION_GATEWAYS]
} as any)  // eslint-disable-line @typescript-eslint/no-explicit-any
export class LinearIntegrationModule {}
