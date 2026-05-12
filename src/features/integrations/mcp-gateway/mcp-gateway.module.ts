import { Module } from '@nestjs/common';
import { INTEGRATION_GATEWAYS } from './integration-gateway.interface';

// multi: true is supported by NestJS at runtime but the TS Provider type
// union does not include the property in its index signature.
const emptyGateways = { provide: INTEGRATION_GATEWAYS, useValue: [], multi: true };

@Module({
  providers: [emptyGateways],
  exports: [INTEGRATION_GATEWAYS]
} as any)
export class McpGatewayModule {}
