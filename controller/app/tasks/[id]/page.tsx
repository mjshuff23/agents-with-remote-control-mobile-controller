'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  approveAction,
  denyAction,
  getTask,
  listTestCommands,
  replayTask,
  restoreTask,
  runTest,
  sendInput,
  stopTask,
  summarizeDiff,
  type ApprovalRequest,
  type DiffSummaryResponse,
  type GitChangeSummary,
  type LogEntry,
  type RuntimeState,
  type Session,
  type SyncEvent,
  type Task,
  type TaskEventEnvelope,
  type TestCommandConfig,
  type TestRunSummary
} from '../../../lib/api';
import { TaskLogPane } from '../../../components/task-log-pane';
import { SyncStatusPanel } from '../../../components/sync-status-panel';
import { ProviderErrorCard } from '../../../components/provider-error-card';
import { IssueLinkCard } from '../../../components/issue-link-card';
import { useTaskSocket } from '../../../lib/use-socket';

const EVENT_DEDUPE_LIMIT = 500;

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [task, setTask] = useState<Task | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [changeSummaries, setChangeSummaries] = useState<DiffSummaryResponse[]>([]);
  const [testRuns, setTestRuns] = useState<TestRunSummary[]>([]);
  const [syncEvents, setSyncEvents] = useState<SyncEvent[]>([]);
  const [testCommands, setTestCommands] = useState<TestCommandConfig[]>([]);
  const [selectedTestCommandId, setSelectedTestCommandId] = useState('');
  const [inputText, setInputText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [denyMessages, setDenyMessages] = useState<Record<string, string>>({});
  const [pendingApprovalActionIds, setPendingApprovalActionIds] = useState<Set<string>>(new Set());
  const seqRef = useRef(0);
  const lastEventSeqRef = useRef(0);
  const syntheticSeqRef = useRef(-1);
  const seenLogKeys = useRef(new Set<string>());
  const seenEvents = useRef(new Set<string>());
  const sessionIdRef = useRef<string>('');

  function markEventSeen(eventId: string): boolean {
    if (seenEvents.current.has(eventId)) {
      return true;
    }
    seenEvents.current.add(eventId);
    if (seenEvents.current.size > EVENT_DEDUPE_LIMIT) {
      const oldest = seenEvents.current.values().next().value;
      if (oldest) {
        seenEvents.current.delete(oldest);
      }
    }
    return false;
  }

  function recordServerLog(log: Pick<LogEntry, 'sessionId' | 'sequence'>) {
    seenLogKeys.current.add(serverLogKey(log.sessionId, log.sequence));
    seqRef.current = Math.max(seqRef.current, log.sequence);
  }

  function appendSyntheticLog(type: string, content: string) {
    const sequence = syntheticSeqRef.current;
    syntheticSeqRef.current -= 1;
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

  function appendServerLogs(nextLogs: LogEntry[]) {
    setLogs((prev) => {
      const missed = nextLogs.filter((log) => {
        const key = serverLogKey(log.sessionId, log.sequence);
        if (seenLogKeys.current.has(key)) return false;
        recordServerLog(log);
        return true;
      });
      if (missed.length === 0) return prev;
      return [...prev, ...missed].sort(compareLogs);
    });
  }

  function applyTaskEvent(event: TaskEventEnvelope) {
    lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
    if (markEventSeen(event.id)) return;

    if (event.name === 'agent.log') return;
    if (event.name === 'approval.requested' || event.name === 'approval.resolved') {
      upsertApproval(event.data as ApprovalRequest);
      return;
    }
    if (event.name === 'policy.violation') {
      const approval = event.data as ApprovalRequest;
      upsertApproval(approval);
      appendSyntheticLog('system', `Policy violation: ${approval.title}`);
      return;
    }
    if (event.name === 'diff.summary') {
      const summary = event.data as DiffSummaryResponse;
      setChangeSummaries((prev) => [summary, ...prev.filter((item) => item.id !== summary.id)].slice(0, 10));
      return;
    }
    if (event.name === 'test.started') {
      appendSyntheticLog('system', `Test started: ${(event.data as { commandId: string }).commandId}`);
      return;
    }
    if (event.name === 'test.log') {
      const data = event.data as { stream: string; content: string };
      appendSyntheticLog('system', `[${data.stream}] ${data.content}`);
      return;
    }
    if (event.name === 'test.completed') {
      const run = event.data as TestRunSummary;
      setTestRuns((prev) => [run, ...prev.filter((item) => item.id !== run.id)].slice(0, 10));
      appendSyntheticLog('system', `Test ${run.status}: ${run.commandId}`);
      return;
    }
    if (event.name === 'task.started') {
      const data = event.data as { task?: Task; session?: Session };
      if (data.task) setTask(data.task);
      if (data.session) setSession(data.session);
      return;
    }
    if (event.name === 'task.completed') {
      const data = event.data as { exitCode: number; status: string };
      setTask((prev) => (prev ? { ...prev, status: data.status } : prev));
      setSession((prev) => (prev ? { ...prev, exitCode: data.exitCode } : prev));
      setRuntime({
        processState: 'terminal',
        statusLabel: data.status === 'failed' ? 'failed' : data.status === 'stopped' ? 'stopped' : 'completed'
      });
    }
  }

  function applyReplay(replay: { events: TaskEventEnvelope[]; logs: LogEntry[] }) {
    appendServerLogs(replay.logs);
    replay.events.forEach(applyTaskEvent);
  }

  useEffect(() => {
    // Reset all per-task state so navigating between tasks doesn't bleed data
    seenLogKeys.current.clear();
    seenEvents.current.clear();
    seqRef.current = 0;
    lastEventSeqRef.current = 0;
    syntheticSeqRef.current = -1;
    sessionIdRef.current = '';
    Promise.all([getTask(id), listTestCommands(id)])
      .then(([details, commands]) => {
        const { task, session, logs, approvals, changeSummaries, testRuns, syncEvents: se, runtime, eventCursor } = details;
        setTask(task);
        setSession(session);
        setRuntime(runtime);
        setApprovals(approvals);
        setChangeSummaries(changeSummaries.map(normalizeStoredDiffSummary));
        setTestRuns(testRuns);
        setSyncEvents(se);
        setTestCommands(commands.testCommands);
        setSelectedTestCommandId(commands.testCommands[0]?.id ?? '');
        sessionIdRef.current = session?.id ?? '';
        lastEventSeqRef.current = eventCursor;
        setLogs(logs);
        if (logs.length > 0) {
          const maxSeq = Math.max(...logs.map((l) => l.sequence));
          seqRef.current = maxSeq;
          logs.forEach(recordServerLog);
        }
      })
      .catch(console.error);
  }, [id]);

  // Re-sync task state after a socket reconnect or tab visibility restore by
  // asking the durable event/log ledger for anything after our last cursors.
  function resyncTask() {
    void Promise.all([
      replayTask(id, {
        afterEventSeq: lastEventSeqRef.current,
        afterLogSequence: seqRef.current
      }),
      getTask(id),
      listTestCommands(id)
    ])
      .then(([replay, details, commands]) => {
        const { task: t, session: s, approvals: fresh, changeSummaries: freshSummaries, testRuns: freshRuns, syncEvents: se, runtime: nextRuntime } = details;
        setTask(t);
        setSession(s);
        setRuntime(nextRuntime);
        applyReplay(replay);
        setApprovals(fresh);
        setChangeSummaries(freshSummaries.map(normalizeStoredDiffSummary));
        setTestRuns(freshRuns);
        setSyncEvents(se);
        setTestCommands(commands.testCommands);
        setSelectedTestCommandId((current) =>
          commands.testCommands.some((command) => command.id === current)
            ? current
            : commands.testCommands[0]?.id ?? ''
        );
      })
      .catch(() => {});
  }

  useTaskSocket(id, {
    onLog: (data) => {
      const seq = data.sequence;
      const liveSessionId = data.sessionId ?? sessionIdRef.current;
      if (seenLogKeys.current.has(serverLogKey(liveSessionId, seq))) return;
      setLogs((prev) => [
        ...prev,
        {
          id: `ws-${seq}`,
          sessionId: liveSessionId,
          type: data.type,
          sequence: seq,
          content: data.content,
          createdAt: new Date().toISOString()
        }
      ]);
      recordServerLog({ sessionId: liveSessionId, sequence: seq });
    },
    onCompleted: (data) => {
      setTask((prev) => (prev ? { ...prev, status: data.status } : null));
      setSession((prev) => (prev ? { ...prev, exitCode: data.exitCode } : prev));
      setRuntime({
        processState: 'terminal',
        statusLabel: data.status === 'failed' ? 'failed' : data.status === 'stopped' ? 'stopped' : 'completed'
      });
    },
    onApprovalRequested: (event) => {
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      upsertApproval(event.data);
    },
    onApprovalResolved: (event) => {
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      upsertApproval(event.data);
    },
    onPolicyViolation: (event) => {
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      upsertApproval(event.data);
      appendSyntheticLog('system', `Policy violation: ${event.data.title}`);
    },
    onSessionDormant: (event) => {
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      setTask((prev) => prev ? { ...prev, status: 'dormant' } : prev);
      setRuntime({ processState: 'reconstructed', statusLabel: 'dormant' });
      appendSyntheticLog('system', `Session dormant: ${event.data.reason}`);
    },
    onSessionRestored: (event) => {
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      setTask((prev) => prev ? { ...prev, status: 'running' } : prev);
      setRuntime({ processState: 'live_process', statusLabel: 'active' });
      appendSyntheticLog('system', `Session restored (${event.data.restoreMode})`);
    },
    onDiffSummary: (event) => {
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      setChangeSummaries((prev) => [event.data, ...prev.filter((summary) => summary.id !== event.data.id)].slice(0, 10));
    },
    onTestStarted: (event) => {
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      appendSyntheticLog('system', `Test started: ${event.data.commandId}`);
    },
    onTestLog: (event) => {
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      appendSyntheticLog('system', `[${event.data.stream}] ${event.data.content}`);
    },
    onTestCompleted: (event) => {
      if (markEventSeen(event.id)) return;
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      setTestRuns((prev) => [event.data, ...prev.filter((run) => run.id !== event.data.id)].slice(0, 10));
      appendSyntheticLog('system', `Test ${event.data.status}: ${event.data.commandId}`);
    },
    getReplayCursor: () => ({
      afterEventSeq: lastEventSeqRef.current,
      afterLogSequence: seqRef.current
    }),
    onReplay: applyReplay,
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

  async function handleRestore() {
    setActionError(null);
    try {
      const result = await restoreTask(id);
      setTask((prev) => prev ? { ...prev, status: 'running' } : prev);
      setSession(result.session);
      setRuntime(result.runtime);
      appendSyntheticLog('system', 'Session restored from dormant');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Restore failed');
    }
  }

  const isLive = runtime?.processState === 'live_process' && (
    runtime.statusLabel === 'active' || runtime.statusLabel === 'waiting_approval'
  );
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
          <p className="text-xs text-gray-400">
            {runtime?.statusLabel === 'dormant' ? (
              <span className="text-purple-700 font-medium">dormant</span>
            ) : task.status}
            {' · '}{task.selectedAgent} · {runtimeLabel(runtime)}
          </p>
        </div>
      </div>

      {(pendingApprovals.length > 0 || latestDiff || testRuns.length > 0 || syncEvents.length > 0) && (
        <div className="shrink-0 max-h-80 overflow-y-auto border-b bg-gray-50 p-3 space-y-3">
          {/* Linked issue */}
          {task.externalIssueRef && (
            <IssueLinkCard ref_={task.externalIssueRef} />
          )}

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

          {/* Phase 4: Sync status and provider errors */}
          <SyncStatusPanel syncEvents={syncEvents} />
          {syncEvents.filter((e) => e.status === 'failed').slice(0, 3).map((event) => (
            <ProviderErrorCard key={event.id} event={event} />
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
        {runtime?.statusLabel === 'dormant' && (
          <div className="space-y-2">
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] px-2 py-0.5 rounded bg-purple-200 text-purple-800 font-semibold">
                  dormant
                </span>
                <span className="text-xs text-gray-500">
                  {task.status === 'dormant' ? 'session checkpointed' : 'no live process'}
                </span>
              </div>
              <p className="text-xs text-gray-500">
                worktree: {task.worktreePath ?? '—'} · branch: {task.branchName ?? '—'}
              </p>
              <p className="text-xs text-gray-500">
                base: {task.baseCommit?.slice(0, 12) ?? '—'}
              </p>
              <p className="text-xs text-gray-400">
                restore will relaunch worker in preserved worktree context
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => void handleRestore()}
                className="bg-purple-600 text-white py-2 rounded-lg text-sm font-semibold active:scale-95 transition-transform"
              >
                Resume
              </button>
              <button
                onClick={() => void handleDiffSummary()}
                className="border border-gray-300 text-gray-700 py-2 rounded-lg text-xs font-semibold hover:bg-gray-50 active:scale-95 transition-all"
              >
                Diff
              </button>
            </div>
          </div>
        )}
        {!isLive && runtime?.statusLabel !== 'dormant' && (
          <p className="text-center text-xs text-gray-400 py-1">
            Task {task.status} · exit {session?.exitCode ?? '—'}
          </p>
        )}
      </div>
    </div>
  );
}

function serverLogKey(sessionId: string, sequence: number): string {
  return `log:${sessionId}:${sequence}`;
}

function runtimeLabel(runtime: RuntimeState | null): string {
  if (!runtime) return 'loading session';
  const state = runtime.processState === 'live_process'
    ? 'live process'
    : runtime.processState === 'terminal'
      ? 'terminal'
      : 'DB reconstructed';
  return `${state} · ${runtime.statusLabel}`;
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

function compareLogs(a: LogEntry, b: LogEntry): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) {
    return byTime;
  }
  return a.sequence - b.sequence;
}
