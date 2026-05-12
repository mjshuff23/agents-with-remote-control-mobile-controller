import { Module } from '@nestjs/common';
import { INTEGRATION_GATEWAYS } from './integration-gateway.interface';

@Module({
  providers: [{ provide: INTEGRATION_GATEWAYS, useValue: [], multi: true }],
  exports: [INTEGRATION_GATEWAYS]
} as any)  // eslint-disable-line @typescript-eslint/no-explicit-any
export class McpGatewayModule {}
