import { Injectable } from '@nestjs/common';
import { IIntegrationGateway, IntegrationReadResult } from '../mcp-gateway/integration-gateway.interface';

@Injectable()
export class LinearAdapter implements IIntegrationGateway {
  readonly name = 'linear';

  async connect(): Promise<void> {
    throw new Error('Linear integration not implemented until Phase 4.');
  }

  async disconnect(): Promise<void> {}

  async read<T = unknown>(): Promise<IntegrationReadResult<T>> {
    return { ok: false, error: 'Linear integration not implemented until Phase 4.' };
  }
}
