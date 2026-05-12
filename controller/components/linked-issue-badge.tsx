import type { ExternalIssueRef } from '../lib/api';

interface LinkedIssueBadgeProps {
  ref_: ExternalIssueRef;
  onClear: () => void;
}

export function LinkedIssueBadge({ ref_, onClear }: LinkedIssueBadgeProps) {
  return (
    <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
      <span className="text-xs font-mono text-blue-600 shrink-0">{ref_.key}</span>
      <span className="text-sm text-blue-900 truncate flex-1">{ref_.title ?? ref_.externalId}</span>
      <span className="text-[11px] text-blue-400 shrink-0 uppercase">{ref_.provider}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Remove linked issue"
        className="text-blue-400 hover:text-blue-600 shrink-0 leading-none"
      >
        ✕
      </button>
    </div>
  );
}
