export type IntegrationReadResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface IIntegrationGateway {
  readonly name: string;
  connect(context?: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  read<T = unknown>(resource: string, params?: Record<string, unknown>): Promise<IntegrationReadResult<T>>;
}

export const INTEGRATION_GATEWAYS = Symbol('INTEGRATION_GATEWAYS');
