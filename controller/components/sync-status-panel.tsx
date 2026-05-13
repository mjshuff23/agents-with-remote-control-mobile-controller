'use client';
import type { SyncEvent } from '../lib/api';

interface SyncStatusPanelProps {
  syncEvents: SyncEvent[];
}

const STATUS_COLORS: Record<string, string> = {
  succeeded: 'text-green-700 bg-green-100',
  failed: 'text-red-700 bg-red-100',
  retryable: 'text-amber-700 bg-amber-100',
  running: 'text-blue-700 bg-blue-100',
  pending: 'text-gray-500 bg-gray-100',
  skipped: 'text-gray-400 bg-gray-100',
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'text-gray-500 bg-gray-100';
}

const ACTION_LABELS: Record<string, string> = {
  commit: 'Commit',
  push: 'Push',
  create_pr: 'PR',
  attach_pr_url: 'Link PR',
  update_status: 'Status',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function SyncStatusPanel({ syncEvents }: SyncStatusPanelProps) {
  if (syncEvents.length === 0) return null;

  return (
    <div className="border border-gray-200 bg-white rounded-lg p-3 space-y-2">
      <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Sync Status</p>
      <div className="space-y-1.5">
        {syncEvents.slice(0, 10).map((event) => (
          <div key={event.id} className="flex items-center gap-2 text-xs">
            <span className={`px-1.5 py-0.5 rounded font-medium ${statusColor(event.status)}`}>
              {event.status}
            </span>
            <span className="font-mono text-gray-600">{event.provider}</span>
            <span className="text-gray-800">{actionLabel(event.action)}</span>
            {event.url && (
              <a
                href={event.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline truncate"
              >
                {event.externalId ? `#${event.externalId}` : 'link'}
              </a>
            )}
            {event.errorCategory && (
              <span className="text-red-600 truncate" title={event.errorMessage ?? ''}>
                {event.errorCategory}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
