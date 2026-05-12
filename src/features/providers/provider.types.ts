export type ProviderName = 'github' | 'linear';

export type ProviderActionStatus = 'succeeded' | 'failed' | 'retryable' | 'skipped';

export type ProviderErrorCategory =
  | 'auth_failed'
  | 'rate_limited'
  | 'not_found'
  | 'conflict'
  | 'validation_error'
  | 'network_error'
  | 'unexpected';

export interface ProviderActionResult {
  provider: ProviderName;
  externalId?: string;
  url?: string;
  status: ProviderActionStatus;
  errorCategory?: ProviderErrorCategory;
  errorMessage?: string;
}

export interface NormalizedProviderError {
  category: ProviderErrorCategory;
  message: string;
  retryable: boolean;
  statusCode?: number;
}

export interface ExternalIssueRef {
  provider: ProviderName;
  externalId: string;
  key: string;
  url?: string;
  title?: string;
}
