'use client';
import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LogEntry } from '../lib/api';

const TYPE_COLOR: Record<string, string> = {
  stdout: 'text-green-400',
  stderr: 'text-red-400',
  system: 'text-yellow-300'
};

interface Props {
  logs: LogEntry[];
  autoScroll?: boolean;
}

export function TaskLogPane({ logs, autoScroll = true }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 30
  });

  // Auto-scroll to bottom when new logs arrive, unless user has scrolled up
  useEffect(() => {
    if (!autoScroll || userScrolled.current || logs.length === 0) return;
    virtualizer.scrollToIndex(logs.length - 1, { align: 'end' });
  }, [logs.length, autoScroll, virtualizer]);

  return (
    <div
      ref={parentRef}
      className="log-scroll h-full overflow-auto bg-gray-950 rounded-lg font-mono text-xs p-2 leading-5"
      onScroll={(e) => {
        const el = e.currentTarget;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 32;
        userScrolled.current = !atBottom;
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const log = logs[item.index];
          return (
            <div
              key={item.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`
              }}
              className={`whitespace-pre-wrap break-all ${TYPE_COLOR[log.type] ?? 'text-gray-300'}`}
            >
              {log.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
