'use client';
import type { SyncEvent, SyncEventStatus, ProviderErrorCategory } from '../lib/api';

interface ProviderErrorCardProps {
  event: SyncEvent;
}

const RETRYABLE_STATUSES: Set<SyncEventStatus> = new Set(['retryable']);
const RETRYABLE_CATEGORIES: Set<ProviderErrorCategory> = new Set(['network_error', 'rate_limited']);

const ERROR_RECOVERY: Record<ProviderErrorCategory, string> = {
  auth_failed: 'Check your provider token/API key and update the environment variables.',
  network_error: 'Check your network connection and try again.',
  rate_limited: 'Provider rate limit reached. Wait a moment and retry.',
  not_found: 'The resource was not found. It may have been deleted or moved.',
  push_rejected: 'The push was rejected by the remote. Check branch protection rules.',
  unknown_error: 'An unexpected error occurred. Check the server logs for details.',
};

function recoveryText(category: ProviderErrorCategory | null): string {
  return category ? (ERROR_RECOVERY[category] ?? ERROR_RECOVERY.unknown_error) : ERROR_RECOVERY.unknown_error;
}

function isRetryable(status: SyncEventStatus, category: ProviderErrorCategory | null): boolean {
  return RETRYABLE_STATUSES.has(status) || (category !== null && RETRYABLE_CATEGORIES.has(category));
}

export function ProviderErrorCard({ event }: ProviderErrorCardProps) {
  const retryable = isRetryable(event.status, event.errorCategory);

  return (
    <div className="border border-red-200 bg-red-50 rounded-lg p-3 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-200 text-red-800 font-medium">
          {event.provider}
        </span>
        <span className="text-xs font-semibold text-red-900">{event.action}</span>
        {event.errorCategory && (
          <span className="text-[11px] text-red-600 ml-auto">{event.errorCategory}</span>
        )}
      </div>
      {event.errorMessage && (
        <p className="text-xs text-red-700 truncate" title={event.errorMessage}>
          {event.errorMessage}
        </p>
      )}
      <p className="text-xs text-red-600">{recoveryText(event.errorCategory)}</p>
      {retryable && (
        <span className="inline-block text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
          retry available
        </span>
      )}
    </div>
  );
}
