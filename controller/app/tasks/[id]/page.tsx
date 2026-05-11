'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getTask, stopTask, sendInput, type Task, type Session, type LogEntry } from '../../../lib/api';
import { TaskLogPane } from '../../../components/task-log-pane';
import { useTaskSocket } from '../../../lib/use-socket';

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [task, setTask] = useState<Task | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [inputText, setInputText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const seenSeqs = useRef(new Set<number>());
  const sessionIdRef = useRef<string>('');

  useEffect(() => {
    getTask(id)
      .then(({ task, session, logs }) => {
        setTask(task);
        setSession(session);
        if (session) sessionIdRef.current = session.id;
        setLogs(logs);
        if (logs.length > 0) {
          const maxSeq = Math.max(...logs.map((l) => l.sequence));
          seqRef.current = maxSeq;
          logs.forEach((l) => seenSeqs.current.add(l.sequence));
        }
      })
      .catch(console.error);
  }, [id]);

  useTaskSocket(id, {
    onLog: (data) => {
      const seq = data.sequence;
      if (seenSeqs.current.has(seq)) return;
      seenSeqs.current.add(seq);
      seqRef.current = Math.max(seqRef.current, seq);
      setLogs((prev) => [
        ...prev,
        {
          id: `ws-${seq}`,
          sessionId: sessionIdRef.current,
          type: data.type,
          sequence: seq,
          content: data.content,
          createdAt: new Date().toISOString()
        }
      ]);
    },
    onCompleted: (data) => {
      setTask((prev) => (prev ? { ...prev, status: data.status } : null));
      setSession((prev) => (prev ? { ...prev, exitCode: data.exitCode } : prev));
    }
  });

  async function handleStop() {
    setActionError(null);
    try {
      await stopTask(id);
      setTask((prev) => (prev ? { ...prev, status: 'stopping' } : null));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Stop failed');
    }
  }

  async function handleSendInput() {
    if (!inputText.trim()) return;
    setActionError(null);
    try {
      await sendInput(id, inputText.trim());
      setInputText('');
      setShowInput(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Send failed');
    }
  }

  const isLive = task?.status === 'running' || task?.status === 'starting';

  if (!task) {
    return <div className="p-4 text-gray-400 text-sm">Loading…</div>;
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 57px)' }}>
      {/* Task header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-white shrink-0">
        <button
          onClick={() => router.push('/')}
          className="text-gray-400 hover:text-gray-600 text-xl leading-none"
        >
          ←
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">{task.title ?? task.prompt.slice(0, 50)}</p>
          <p className="text-xs text-gray-400">{task.status} · {task.selectedAgent}</p>
        </div>
      </div>

      {/* Log pane (takes all remaining space) */}
      <div className="flex-1 min-h-0 p-2">
        <TaskLogPane logs={logs} />
      </div>

      {/* Action bar */}
      <div className="shrink-0 p-3 border-t bg-white space-y-2">
        {showInput && (
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSendInput(); }}
              placeholder="Type input for the agent…"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <button
              onClick={() => void handleSendInput()}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold"
            >
              Send
            </button>
            <button
              onClick={() => setShowInput(false)}
              className="text-gray-400 px-2 py-2 text-sm"
            >
              ✕
            </button>
          </div>
        )}
        {isLive && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowInput((s) => !s)}
              className="flex-1 border border-blue-500 text-blue-600 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-50 active:scale-95 transition-all"
            >
              Continue
            </button>
            <button
              onClick={() => void handleStop()}
              className="flex-1 border border-red-500 text-red-600 py-2.5 rounded-lg text-sm font-semibold hover:bg-red-50 active:scale-95 transition-all"
            >
              Stop
            </button>
          </div>
        )}
        {!isLive && (
          <p className="text-center text-xs text-gray-400 py-1">
            Task {task.status} · exit {session?.exitCode ?? '—'}
          </p>
        )}
      </div>
    </div>
  );
}
