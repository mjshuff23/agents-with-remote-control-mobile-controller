'use client';
import type { SyncEvent } from '../lib/api';

interface ProviderErrorCardProps {
  event: SyncEvent;
}

const ERROR_RECOVERY: Record<string, string> = {
  auth_failed: 'Check your provider token/API key and update the environment variables.',
  network_error: 'Check your network connection and try again.',
  rate_limited: 'Provider rate limit reached. Wait a moment and retry.',
  not_found: 'The resource was not found. It may have been deleted or moved.',
  push_rejected: 'The push was rejected by the remote. Check branch protection rules.',
  unknown_error: 'An unexpected error occurred. Check the server logs for details.',
};

function recoveryText(category: string | null): string {
  if (!category) return ERROR_RECOVERY.unknown_error;
  return ERROR_RECOVERY[category] ?? ERROR_RECOVERY.unknown_error;
}

export function ProviderErrorCard({ event }: ProviderErrorCardProps) {
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
    </div>
  );
}
