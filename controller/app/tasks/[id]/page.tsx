'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  approveAction,
  denyAction,
  getTask,
  runTest,
  sendInput,
  stopTask,
  summarizeDiff,
  type ApprovalRequest,
  type GitChangeSummary,
  type LogEntry,
  type Session,
  type Task,
  type TestRunSummary
} from '../../../lib/api';
import { TaskLogPane } from '../../../components/task-log-pane';
import { useTaskSocket } from '../../../lib/use-socket';

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [task, setTask] = useState<Task | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [changeSummaries, setChangeSummaries] = useState<GitChangeSummary[]>([]);
  const [testRuns, setTestRuns] = useState<TestRunSummary[]>([]);
  const [inputText, setInputText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [denyMessages, setDenyMessages] = useState<Record<string, string>>({});
  const seqRef = useRef(0);
  const seenSeqs = useRef(new Set<number>());
  const seenEvents = useRef(new Set<string>());
  const sessionIdRef = useRef<string>('');

  useEffect(() => {
    // Reset all per-task state so navigating between tasks doesn't bleed data
    seenSeqs.current.clear();
    seenEvents.current.clear();
    seqRef.current = 0;
    sessionIdRef.current = '';
    setLogs([]);
    setApprovals([]);
    setChangeSummaries([]);
    setTestRuns([]);
    setTask(null);
    setSession(null);

    getTask(id)
      .then(({ task, session, logs, approvals, changeSummaries, testRuns }) => {
        setTask(task);
        setSession(session);
        setApprovals(approvals);
        setChangeSummaries(changeSummaries);
        setTestRuns(testRuns);
        sessionIdRef.current = session?.id ?? '';
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
    },
    onApprovalRequested: (event) => {
      if (seenEvents.current.has(event.id)) return;
      seenEvents.current.add(event.id);
      upsertApproval(event.data);
    },
    onApprovalResolved: (event) => {
      if (seenEvents.current.has(event.id)) return;
      seenEvents.current.add(event.id);
      upsertApproval(event.data);
    },
    onPolicyViolation: (event) => {
      if (seenEvents.current.has(event.id)) return;
      seenEvents.current.add(event.id);
      upsertApproval(event.data);
      appendSyntheticLog('system', `Policy violation: ${event.data.title}`);
    },
    onDiffSummary: (event) => {
      if (seenEvents.current.has(event.id)) return;
      seenEvents.current.add(event.id);
      setChangeSummaries((prev) => [event.data, ...prev.filter((summary) => summary.id !== event.data.id)].slice(0, 10));
    },
    onTestStarted: (event) => {
      if (seenEvents.current.has(event.id)) return;
      seenEvents.current.add(event.id);
      appendSyntheticLog('system', `Test started: ${event.data.commandId}`);
    },
    onTestLog: (event) => {
      if (seenEvents.current.has(event.id)) return;
      seenEvents.current.add(event.id);
      appendSyntheticLog('system', `[${event.data.stream}] ${event.data.content}`);
    },
    onTestCompleted: (event) => {
      if (seenEvents.current.has(event.id)) return;
      seenEvents.current.add(event.id);
      setTestRuns((prev) => [event.data, ...prev.filter((run) => run.id !== event.data.id)].slice(0, 10));
      appendSyntheticLog('system', `Test ${event.data.status}: ${event.data.commandId}`);
    }
  });

  function appendSyntheticLog(type: string, content: string) {
    const sequence = seqRef.current + 1;
    seqRef.current = sequence;
    setLogs((prev) => [
      ...prev,
      {
        id: `ui-${sequence}`,
        sessionId: sessionIdRef.current,
        type,
        sequence,
        content,
        createdAt: new Date().toISOString()
      }
    ]);
  }

  function upsertApproval(approval: ApprovalRequest) {
    setApprovals((prev) => [approval, ...prev.filter((item) => item.id !== approval.id)].slice(0, 50));
  }

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

  async function handleApprove(approvalId: string) {
    setActionError(null);
    try {
      const result = await approveAction(approvalId);
      upsertApproval(result.approval);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approval failed');
    }
  }

  async function handleDeny(approvalId: string) {
    setActionError(null);
    try {
      const result = await denyAction(approvalId, denyMessages[approvalId]);
      upsertApproval(result.approval);
      setDenyMessages((prev) => ({ ...prev, [approvalId]: '' }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Deny failed');
    }
  }

  async function handleDiffSummary() {
    setActionError(null);
    try {
      const summary = await summarizeDiff(id);
      setChangeSummaries((prev) => [summary, ...prev.filter((item) => item.id !== summary.id)].slice(0, 10));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Diff summary failed');
    }
  }

  async function handleRunTests() {
    setActionError(null);
    try {
      const started = await runTest(id, 'root:test');
      setTestRuns((prev) => [started, ...prev.filter((item) => item.id !== started.id)].slice(0, 10));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Test run failed');
    }
  }

  const isLive = task?.status === 'running' || task?.status === 'starting' || task?.status === 'waiting_approval';
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const latestDiff = changeSummaries[0];

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

      {(pendingApprovals.length > 0 || latestDiff || testRuns.length > 0) && (
        <div className="shrink-0 max-h-72 overflow-y-auto border-b bg-gray-50 p-3 space-y-3">
          {pendingApprovals.map((approval) => {
            const command = parseJson<string[]>(approval.commandJson, []);
            const files = parseJson<string[]>(approval.filesJson, []);
            return (
              <div key={approval.id} className="border border-amber-200 bg-white rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{approval.title}</p>
                    <p className="text-xs text-amber-700">{approval.actionType} · {approval.riskLevel}</p>
                  </div>
                  <span className="text-[11px] px-2 py-1 rounded bg-amber-100 text-amber-800 shrink-0">
                    pending
                  </span>
                </div>
                {approval.rationale && <p className="text-xs text-gray-600">{approval.rationale}</p>}
                {command.length > 0 && <p className="text-xs font-mono text-gray-700 bg-gray-100 rounded px-2 py-1 break-all">{command.join(' ')}</p>}
                {files.length > 0 && <p className="text-xs text-gray-500 truncate">{files.slice(0, 4).join(', ')}</p>}
                <textarea
                  value={denyMessages[approval.id] ?? ''}
                  onChange={(e) => setDenyMessages((prev) => ({ ...prev, [approval.id]: e.target.value }))}
                  placeholder="Optional denial message"
                  rows={2}
                  className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleApprove(approval.id)}
                    className="flex-1 bg-green-600 text-white py-2 rounded text-xs font-semibold"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void handleDeny(approval.id)}
                    className="flex-1 border border-red-500 text-red-600 py-2 rounded text-xs font-semibold"
                  >
                    Deny
                  </button>
                </div>
              </div>
            );
          })}

          {latestDiff && (
            <div className="border border-blue-200 bg-white rounded-lg p-3">
              <div className="flex justify-between text-sm font-semibold text-gray-900">
                <span>Diff Summary</span>
                <span>{latestDiff.filesChanged} files</span>
              </div>
              <p className="text-xs text-gray-500">
                +{latestDiff.insertions} / -{latestDiff.deletions} · A{latestDiff.addedCount} M{latestDiff.modifiedCount} D{latestDiff.deletedCount} R{latestDiff.renamedCount}
              </p>
              {parseJson<string[]>(latestDiff.riskFlagsJson, []).length > 0 && (
                <p className="mt-1 text-xs text-amber-700">
                  {parseJson<string[]>(latestDiff.riskFlagsJson, []).join(', ')}
                </p>
              )}
            </div>
          )}

          {testRuns.slice(0, 3).map((run) => (
            <div key={run.id} className="border border-gray-200 bg-white rounded-lg p-3">
              <div className="flex justify-between text-sm font-semibold text-gray-900">
                <span>{run.commandId}</span>
                <span className={run.status === 'passed' ? 'text-green-700' : run.status === 'failed' ? 'text-red-700' : 'text-blue-700'}>
                  {run.status}
                </span>
              </div>
              <p className="text-xs text-gray-500">exit {run.exitCode ?? 'running'}</p>
            </div>
          ))}
        </div>
      )}

      {/* Log pane (takes all remaining space) */}
      <div className="flex-1 min-h-0 p-2">
        <TaskLogPane logs={logs} />
      </div>

      {/* Action bar */}
      <div className="shrink-0 p-3 border-t bg-white space-y-2">
        {actionError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {actionError}
          </p>
        )}
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
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setShowInput((s) => !s)}
              className="border border-blue-500 text-blue-600 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-50 active:scale-95 transition-all"
            >
              Continue
            </button>
            <button
              onClick={() => void handleStop()}
              className="border border-red-500 text-red-600 py-2.5 rounded-lg text-sm font-semibold hover:bg-red-50 active:scale-95 transition-all"
            >
              Stop
            </button>
            <button
              onClick={() => void handleDiffSummary()}
              className="border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-50 active:scale-95 transition-all"
            >
              Diff
            </button>
            <button
              onClick={() => void handleRunTests()}
              className="border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-50 active:scale-95 transition-all"
            >
              Test
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

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
