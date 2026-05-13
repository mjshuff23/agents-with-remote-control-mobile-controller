'use client';
import type { ExternalIssueRef } from '../lib/api';

interface IssueLinkCardProps {
  ref_: ExternalIssueRef;
}

export function IssueLinkCard({ ref_ }: IssueLinkCardProps) {
  const icon = ref_.provider === 'github' ? 'GH' : 'LIN';
  const iconColor = ref_.provider === 'github' ? 'bg-gray-800 text-white' : 'bg-purple-600 text-white';

  return (
    <div className="border border-blue-200 bg-blue-50 rounded-lg p-3 space-y-1">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${iconColor}`}>{icon}</span>
        <span className="text-xs font-semibold text-blue-900 truncate">{ref_.key}</span>
        {ref_.url && (
          <a
            href={ref_.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline text-xs ml-auto shrink-0"
          >
            open ↗
          </a>
        )}
      </div>
      {ref_.title && <p className="text-xs text-blue-700 truncate">{ref_.title}</p>}
    </div>
  );
}
