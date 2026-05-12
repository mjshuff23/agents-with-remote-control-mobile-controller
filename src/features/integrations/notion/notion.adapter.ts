import { Injectable } from '@nestjs/common';
import { IIntegrationGateway, IntegrationReadResult } from '../mcp-gateway/integration-gateway.interface';

@Injectable()
export class NotionAdapter implements IIntegrationGateway {
  readonly name = 'notion';

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async read<T = unknown>(resource: string): Promise<IntegrationReadResult<T>> {
    return { ok: false, error: `Notion integration not implemented until Phase 4. Requested resource: ${resource}` };
  }
}
