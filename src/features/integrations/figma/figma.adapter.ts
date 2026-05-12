import { Injectable } from '@nestjs/common';
import { IIntegrationGateway, IntegrationReadResult } from '../mcp-gateway/integration-gateway.interface';

@Injectable()
export class FigmaAdapter implements IIntegrationGateway {
  readonly name = 'figma';

  async connect(): Promise<void> {
    throw new Error('Figma integration not implemented until Phase 4.');
  }

  async disconnect(): Promise<void> {}

  async read<T = unknown>(): Promise<IntegrationReadResult<T>> {
    return { ok: false, error: 'Figma integration not implemented until Phase 4.' };
  }
}
