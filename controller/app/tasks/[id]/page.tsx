'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  approveAction,
  denyAction,
  getTask,
  listTestCommands,
  runTest,
  sendInput,
  stopTask,
  summarizeDiff,
  type ApprovalRequest,
  type DiffSummaryResponse,
  type GitChangeSummary,
  type LogEntry,
  type Session,
  type Task,
  type TestCommandConfig,
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
  const [changeSummaries, setChangeSummaries] = useState<DiffSummaryResponse[]>([]);
  const [testRuns, setTestRuns] = useState<TestRunSummary[]>([]);
  const [testCommands, setTestCommands] = useState<TestCommandConfig[]>([]);
  const [selectedTestCommandId, setSelectedTestCommandId] = useState('');
  const [inputText, setInputText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [denyMessages, setDenyMessages] = useState<Record<string, string>>({});
  const [pendingApprovalActionIds, setPendingApprovalActionIds] = useState<Set<string>>(new Set());
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
    setTestCommands([]);
    setSelectedTestCommandId('');
    setTask(null);
    setSession(null);

    Promise.all([getTask(id), listTestCommands(id)])
      .then(([details, commands]) => {
        const { task, session, logs, approvals, changeSummaries, testRuns } = details;
        setTask(task);
        setSession(session);
        setApprovals(approvals);
        setChangeSummaries(changeSummaries.map(normalizeStoredDiffSummary));
        setTestRuns(testRuns);
        setTestCommands(commands.testCommands);
        setSelectedTestCommandId(commands.testCommands[0]?.id ?? '');
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

  // Re-sync task state after a socket reconnect or tab visibility restore.
  // Events emitted while the socket was disconnected are permanently lost,
  // so we re-fetch from REST and merge any missed data.
  function resyncTask() {
    void getTask(id)
      .then(({ task: t, session: s, logs: freshLogs, approvals: fresh }) => {
        setTask(t);
        setSession(s);
        setLogs((prev) => {
          const known = new Set(prev.map((l) => l.sequence));
          const missed = freshLogs.filter((l) => !known.has(l.sequence));
          missed.forEach((l) => seenSeqs.current.add(l.sequence));
          if (missed.length === 0) return prev;
          return [...prev, ...missed].sort((a, b) => a.sequence - b.sequence);
        });
        setApprovals(fresh);
      })
      .catch(() => {});
  }

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
    },
    onReconnected: resyncTask
  });

  // Re-sync when the tab/app becomes visible again (mobile backgrounding
  // can silently drop the WebSocket and we miss events while hidden).
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') resyncTask();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  // resyncTask captures stable refs; id is the only meaningful dependency
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Send failed');
    }
  }

  async function handleApprove(approvalId: string) {
    setActionError(null);
    setPendingApprovalActionIds((prev) => new Set(prev).add(approvalId));
    try {
      const result = await approveAction(approvalId);
      upsertApproval(result.approval);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setPendingApprovalActionIds((prev) => {
        const next = new Set(prev);
        next.delete(approvalId);
        return next;
      });
    }
  }

  async function handleDeny(approvalId: string) {
    setActionError(null);
    setPendingApprovalActionIds((prev) => new Set(prev).add(approvalId));
    try {
      const result = await denyAction(approvalId, denyMessages[approvalId]);
      upsertApproval(result.approval);
      setDenyMessages((prev) => ({ ...prev, [approvalId]: '' }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Deny failed');
    } finally {
      setPendingApprovalActionIds((prev) => {
        const next = new Set(prev);
        next.delete(approvalId);
        return next;
      });
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
    if (!selectedTestCommandId) {
      setActionError('No configured test command is available for this task.');
      return;
    }
    try {
      const started = await runTest(id, selectedTestCommandId);
      setTestRuns((prev) => [started, ...prev.filter((item) => item.id !== started.id)].slice(0, 10));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Test run failed');
    }
  }

  const isLive = task?.status === 'running' || task?.status === 'starting' || task?.status === 'waiting_approval';
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

  // Safety-net poll: if the task is waiting for approval but the UI has no
  // pending approval cards, the WS event was likely missed (network transition,
  // page already open when approval fired). Re-fetch until one appears.
  useEffect(() => {
    if (task?.status !== 'waiting_approval' || pendingApprovals.length > 0) return;
    const intervalId = setInterval(() => {
      void getTask(id)
        .then(({ approvals: fresh }) => {
          fresh.forEach((a) => {
            setApprovals((prev) => [a, ...prev.filter((x) => x.id !== a.id)].slice(0, 50));
          });
        })
        .catch(() => {});
    }, 3_000);
    return () => clearInterval(intervalId);
  }, [task?.status, pendingApprovals.length, id]);
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
            const isResolving = pendingApprovalActionIds.has(approval.id);
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
                    disabled={isResolving}
                    className="flex-1 bg-green-600 text-white py-2 rounded text-xs font-semibold disabled:opacity-50"
                  >
                    {isResolving ? 'Working…' : 'Approve'}
                  </button>
                  <button
                    onClick={() => void handleDeny(approval.id)}
                    disabled={isResolving}
                    className="flex-1 border border-red-500 text-red-600 py-2 rounded text-xs font-semibold disabled:opacity-50"
                  >
                    {isResolving ? 'Working…' : 'Deny'}
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
              {latestDiff.riskFlags.length > 0 && (
                <p className="mt-1 text-xs text-amber-700">
                  {latestDiff.riskFlags.join(', ')}
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
        {isLive && (
          <>
            {/* Terminal-style input — always visible while the task is running */}
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSendInput(); }}
                placeholder="Send input to agent…"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => void handleSendInput()}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold active:scale-95 transition-transform"
              >
                Send
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => void handleStop()}
                className="border border-red-500 text-red-600 py-2 rounded-lg text-xs font-semibold hover:bg-red-50 active:scale-95 transition-all"
              >
                Stop
              </button>
              <button
                onClick={() => void handleDiffSummary()}
                className="border border-gray-300 text-gray-700 py-2 rounded-lg text-xs font-semibold hover:bg-gray-50 active:scale-95 transition-all"
              >
                Diff
              </button>
              <button
                onClick={() => void handleRunTests()}
                disabled={!selectedTestCommandId}
                className="border border-gray-300 text-gray-700 py-2 rounded-lg text-xs font-semibold hover:bg-gray-50 active:scale-95 transition-all disabled:opacity-40"
              >
                Test
              </button>
              {testCommands.length > 1 && (
                <select
                  value={selectedTestCommandId}
                  onChange={(e) => setSelectedTestCommandId(e.target.value)}
                  className="col-span-3 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  {testCommands.map((command) => (
                    <option key={command.id} value={command.id}>
                      {command.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </>
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

function normalizeStoredDiffSummary(summary: GitChangeSummary): DiffSummaryResponse {
  return {
    id: summary.id,
    taskId: summary.taskId,
    sessionId: summary.sessionId,
    statusText: summary.statusText,
    filesChanged: summary.filesChanged,
    insertions: summary.insertions,
    deletions: summary.deletions,
    addedCount: summary.addedCount,
    modifiedCount: summary.modifiedCount,
    deletedCount: summary.deletedCount,
    renamedCount: summary.renamedCount,
    riskFlags: parseJson<string[]>(summary.riskFlagsJson, []),
    topFiles: parseJson<Array<{ path: string; insertions: number; deletions: number; status?: string }>>(summary.topFilesJson, []),
    createdAt: summary.createdAt
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
