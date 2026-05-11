'use client';
import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LogEntry } from '../lib/api';

// Strip ANSI/VT escape codes emitted by the PTY
const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

type CodexEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number; reasoning_output_tokens?: number } }
  | { type: 'item.completed'; item: { id: string; type: string; text?: string } }
  | { type: 'error'; message?: string }
  | { type: string };

function tryParseCodexEvent(content: string): CodexEvent | null {
  const t = content.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t) as CodexEvent; }
  catch { return null; }
}

const STREAM_COLOR: Record<string, string> = {
  stderr: 'text-red-400',
  system: 'text-yellow-300'
};

function LogLine({ log }: { log: LogEntry }) {
  const clean = stripAnsi(log.content);
  const event = tryParseCodexEvent(clean);

  if (event) {
    switch (event.type) {
      case 'thread.started':
        return (
          <span className="text-gray-600">
            ◉ session {(event as Extract<CodexEvent, { type: 'thread.started' }>).thread_id.slice(0, 8)}
          </span>
        );
      case 'turn.started':
        return <span className="text-gray-600">▶ turn started</span>;
      case 'turn.completed': {
        const { output_tokens, input_tokens, reasoning_output_tokens } = (event as Extract<CodexEvent, { type: 'turn.completed' }>).usage;
        const reasoning = reasoning_output_tokens ? ` (${reasoning_output_tokens} reasoning)` : '';
        return (
          <span className="text-gray-500">
            ✓ {output_tokens} tokens out{reasoning} · {input_tokens.toLocaleString()} in
          </span>
        );
      }
      case 'item.completed': {
        const item = (event as Extract<CodexEvent, { type: 'item.completed' }>).item;
        if (item.type === 'agent_message' && item.text) {
          return <span className="text-white">{item.text}</span>;
        }
        return <span className="text-gray-600">[{item.type}]</span>;
      }
      case 'error': {
        const msg = (event as Extract<CodexEvent, { type: 'error' }>).message ?? 'unknown error';
        return <span className="text-red-400">✗ {msg}</span>;
      }
      default:
        return <span className="text-gray-600 italic">[{event.type}]</span>;
    }
  }

  // Non-JSON line (system log, ANSI-stripped stderr, plain text)
  return <span className={STREAM_COLOR[log.type] ?? 'text-green-400'}>{clean}</span>;
}

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
              className="whitespace-pre-wrap break-all"
            >
              <LogLine log={log} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
