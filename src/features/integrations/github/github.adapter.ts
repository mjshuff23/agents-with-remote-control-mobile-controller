import { Injectable } from '@nestjs/common';
import { IIntegrationGateway, IntegrationReadResult } from '../mcp-gateway/integration-gateway.interface';

@Injectable()
export class GithubAdapter implements IIntegrationGateway {
  readonly name = 'github';

  async connect(): Promise<void> {
    throw new Error('GitHub integration not implemented until Phase 4.');
  }

  async disconnect(): Promise<void> {}

  async read<T = unknown>(): Promise<IntegrationReadResult<T>> {
    return { ok: false, error: 'GitHub integration not implemented until Phase 4.' };
  }
}
