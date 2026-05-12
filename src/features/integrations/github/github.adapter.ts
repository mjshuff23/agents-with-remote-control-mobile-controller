import { Injectable } from '@nestjs/common';
import { IIntegrationGateway, IntegrationReadResult } from '../mcp-gateway/integration-gateway.interface';

@Injectable()
export class GithubAdapter implements IIntegrationGateway {
  readonly name = 'github';

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async read<T = unknown>(resource: string): Promise<IntegrationReadResult<T>> {
    return { ok: false, error: `GitHub integration not implemented until Phase 4. Requested resource: ${resource}` };
  }
}
