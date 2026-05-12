import { Module } from '@nestjs/common';
import { INTEGRATION_GATEWAYS } from '../mcp-gateway/integration-gateway.interface';
import { FigmaAdapter } from './figma.adapter';

@Module({
  providers: [FigmaAdapter, { provide: INTEGRATION_GATEWAYS, useFactory: (a: FigmaAdapter) => [a], multi: true, inject: [FigmaAdapter] }],
  exports: [INTEGRATION_GATEWAYS]
} as any)  // eslint-disable-line @typescript-eslint/no-explicit-any
export class FigmaIntegrationModule {}
