'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  type Task,
  type TaskEventEnvelope,
  type TestCommandConfig,
  type TestRunSummary
} from '../../lib/api';
import { useTaskSocket } from '../../lib/use-socket';

const EVENT_DEDUPE_LIMIT = 500;

export function useTaskDetail(id: string) {
  const [task, setTask] = useState<Task | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [changeSummaries, setChangeSummaries] = useState<DiffSummaryResponse[]>([]);
  const [testRuns, setTestRuns] = useState<TestRunSummary[]>([]);
  const [testCommands, setTestCommands] = useState<TestCommandConfig[]>([]);
  const [selectedTestCommandId, setSelectedTestCommandId] = useState('');
  const [inputText, setInputText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [denyMessages, setDenyMessages] = useState<Record<string, string>>({});
  const [pendingApprovalActionIds, setPendingApprovalActionIds] = useState<Set<string>>(new Set());

  const denyMessagesRef = useRef(denyMessages);
  denyMessagesRef.current = denyMessages;

  const seqRef = useRef(0);
  const lastEventSeqRef = useRef(0);
  const syntheticSeqRef = useRef(-1);
  const seenLogKeys = useRef(new Set<string>());
  const seenEvents = useRef(new Set<string>());
  const sessionIdRef = useRef<string>('');

  const isLive = runtime?.processState === 'live_process' && (
    runtime.statusLabel === 'active' || runtime.statusLabel === 'waiting_approval'
  );
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const latestDiff = changeSummaries[0];

  const markEventSeen = useCallback((eventId: string): boolean => {
    if (seenEvents.current.has(eventId)) return true;
    seenEvents.current.add(eventId);
    if (seenEvents.current.size > EVENT_DEDUPE_LIMIT) {
      const oldest = seenEvents.current.values().next().value;
      if (oldest) seenEvents.current.delete(oldest);
    }
    return false;
  }, []);

  const recordServerLog = useCallback((log: Pick<LogEntry, 'sessionId' | 'sequence'>) => {
    seenLogKeys.current.add(serverLogKey(log.sessionId, log.sequence));
    seqRef.current = Math.max(seqRef.current, log.sequence);
  }, []);

  const appendSyntheticLog = useCallback((type: string, content: string) => {
    const sequence = syntheticSeqRef.current;
    syntheticSeqRef.current -= 1;
    setLogs((prev) => [...prev, {
      id: `ui-${sequence}`, sessionId: sessionIdRef.current, type, sequence,
      content, createdAt: new Date().toISOString()
    }]);
  }, []);

  const upsertApproval = useCallback((approval: ApprovalRequest) => {
    setApprovals((prev) => [approval, ...prev.filter((item) => item.id !== approval.id)].slice(0, 50));
  }, []);

  const appendServerLogs = useCallback((nextLogs: LogEntry[]) => {
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
  }, [recordServerLog]);

  const applyTaskEvent = useCallback((event: TaskEventEnvelope) => {
    lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
    if (markEventSeen(event.id)) return;

    if (event.name === 'agent.log') return;
    if (event.name === 'approval.requested' || event.name === 'approval.resolved') {
      upsertApproval(event.data as ApprovalRequest);
      return;
    }
    if (event.name === 'policy.violation') {
      upsertApproval(event.data as ApprovalRequest);
      appendSyntheticLog('system', `Policy violation: ${(event.data as ApprovalRequest).title}`);
      return;
    }
    if (event.name === 'diff.summary') {
      const summary = event.data as DiffSummaryResponse;
      setChangeSummaries((prev) => [summary, ...prev.filter((i) => i.id !== summary.id)].slice(0, 10));
      return;
    }
    if (event.name === 'test.started') {
      appendSyntheticLog('system', `Test started: ${(event.data as { commandId: string }).commandId}`);
      return;
    }
    if (event.name === 'test.log') {
      const d = event.data as { stream: string; content: string };
      appendSyntheticLog('system', `[${d.stream}] ${d.content}`);
      return;
    }
    if (event.name === 'test.completed') {
      const run = event.data as TestRunSummary;
      setTestRuns((prev) => [run, ...prev.filter((i) => i.id !== run.id)].slice(0, 10));
      appendSyntheticLog('system', `Test ${run.status}: ${run.commandId}`);
      return;
    }
    if (event.name === 'task.started') {
      const d = event.data as { task?: Task; session?: Session };
      if (d.task) setTask(d.task);
      if (d.session) setSession(d.session);
      return;
    }
    if (event.name === 'task.completed') {
      const d = event.data as { exitCode: number; status: string };
      setTask((prev) => (prev ? { ...prev, status: d.status } : prev));
      setSession((prev) => (prev ? { ...prev, exitCode: d.exitCode } : prev));
      setRuntime({ processState: 'terminal', statusLabel: d.status === 'failed' ? 'failed' : d.status === 'stopped' ? 'stopped' : 'completed' });
    }
  }, [markEventSeen, upsertApproval, appendSyntheticLog]);

  const applyReplay = useCallback((replay: { events: TaskEventEnvelope[]; logs: LogEntry[] }) => {
    appendServerLogs(replay.logs);
    replay.events.forEach(applyTaskEvent);
  }, [appendServerLogs, applyTaskEvent]);

  const resyncTask = useCallback(() => {
    void Promise.all([
      replayTask(id, { afterEventSeq: lastEventSeqRef.current, afterLogSequence: seqRef.current }),
      getTask(id),
      listTestCommands(id)
    ]).then(([replay, details, commands]) => {
      const { task: t, session: s, approvals: fresh, changeSummaries: freshSummaries, testRuns: freshRuns, runtime: nextRuntime } = details;
      setTask(t);
      setSession(s);
      setRuntime(nextRuntime);
      applyReplay(replay);
      setApprovals(fresh);
      setChangeSummaries(freshSummaries.map(normalizeStoredDiffSummary));
      setTestRuns(freshRuns);
      setTestCommands(commands.testCommands);
      setSelectedTestCommandId((current) => commands.testCommands.some((c) => c.id === current) ? current : commands.testCommands[0]?.id ?? '');
    }).catch(console.error);
  }, [id, applyReplay]);

  useEffect(() => {
    let stale = false;
    seenLogKeys.current.clear();
    seenEvents.current.clear();
    seqRef.current = 0;
    lastEventSeqRef.current = 0;
    syntheticSeqRef.current = -1;
    sessionIdRef.current = '';
    Promise.all([getTask(id), listTestCommands(id)])
      .then(([details, commands]) => {
        if (stale) return;
        const { task, session, logs, approvals, changeSummaries, testRuns, runtime, eventCursor } = details;
        setTask(task);
        setSession(session);
        setRuntime(runtime);
        setApprovals(approvals);
        setChangeSummaries(changeSummaries.map(normalizeStoredDiffSummary));
        setTestRuns(testRuns);
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
    return () => { stale = true; };
  }, [id, recordServerLog]);

  useTaskSocket(id, {
    onLog: (data) => {
      const seq = data.sequence;
      const liveSessionId = data.sessionId ?? sessionIdRef.current;
      if (seenLogKeys.current.has(serverLogKey(liveSessionId, seq))) return;
      setLogs((prev) => [...prev, {
        id: `ws-${seq}`, sessionId: liveSessionId, type: data.type,
        sequence: seq, content: data.content, createdAt: new Date().toISOString()
      }]);
      recordServerLog({ sessionId: liveSessionId, sequence: seq });
    },
    onCompleted: (data) => {
      setTask((prev) => (prev ? { ...prev, status: data.status } : null));
      setSession((prev) => (prev ? { ...prev, exitCode: data.exitCode } : prev));
      setRuntime({ processState: 'terminal', statusLabel: data.status === 'failed' ? 'failed' : data.status === 'stopped' ? 'stopped' : 'completed' });
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
      setChangeSummaries((prev) => [event.data, ...prev.filter((s) => s.id !== event.data.id)].slice(0, 10));
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
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
      if (markEventSeen(event.id)) return;
      setTestRuns((prev) => [event.data, ...prev.filter((r) => r.id !== event.data.id)].slice(0, 10));
      appendSyntheticLog('system', `Test ${event.data.status}: ${event.data.commandId}`);
    },
    getReplayCursor: () => ({ afterEventSeq: lastEventSeqRef.current, afterLogSequence: seqRef.current }),
    onReplay: applyReplay,
    onReconnected: resyncTask
  });

  useEffect(() => {
    const handleVisibility = () => { if (document.visibilityState === 'visible') resyncTask(); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [resyncTask]);

  useEffect(() => {
    if (task?.status !== 'waiting_approval' || pendingApprovals.length > 0) return;
    const intervalId = setInterval(() => {
      void getTask(id).then(({ approvals: fresh }) => {
        fresh.forEach((a) => {
          setApprovals((prev) => [a, ...prev.filter((x) => x.id !== a.id)].slice(0, 50));
        });
      }).catch(() => {});
    }, 3_000);
    return () => clearInterval(intervalId);
  }, [task?.status, pendingApprovals.length, id]);

  const handleStop = useCallback(async () => {
    setActionError(null);
    try {
      await stopTask(id);
      setTask((prev) => (prev ? { ...prev, status: 'stopping' } : null));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Stop failed');
    }
  }, [id]);

  const handleSendInput = useCallback(async () => {
    if (!inputText.trim()) return;
    setActionError(null);
    try {
      await sendInput(id, inputText.trim());
      setInputText('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Send failed');
    }
  }, [id, inputText]);

  const handleApprove = useCallback(async (approvalId: string) => {
    setActionError(null);
    setPendingApprovalActionIds((prev) => new Set(prev).add(approvalId));
    try {
      const result = await approveAction(approvalId);
      upsertApproval(result.approval);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setPendingApprovalActionIds((prev) => { const n = new Set(prev); n.delete(approvalId); return n; });
    }
  }, [upsertApproval]);

  const handleDeny = useCallback(async (approvalId: string) => {
    const msg = denyMessagesRef.current[approvalId];
    setActionError(null);
    setPendingApprovalActionIds((prev) => new Set(prev).add(approvalId));
    try {
      const result = await denyAction(approvalId, msg);
      upsertApproval(result.approval);
      setDenyMessages((prev) => ({ ...prev, [approvalId]: '' }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Deny failed');
    } finally {
      setPendingApprovalActionIds((prev) => { const n = new Set(prev); n.delete(approvalId); return n; });
    }
  }, [upsertApproval]);

  const handleDiffSummary = useCallback(async () => {
    setActionError(null);
    try {
      const summary = await summarizeDiff(id);
      setChangeSummaries((prev) => [summary, ...prev.filter((i) => i.id !== summary.id)].slice(0, 10));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Diff summary failed');
    }
  }, [id]);

  const handleRunTests = useCallback(async () => {
    setActionError(null);
    if (!selectedTestCommandId) {
      setActionError('No configured test command is available for this task.');
      return;
    }
    try {
      const started = await runTest(id, selectedTestCommandId);
      setTestRuns((prev) => [started, ...prev.filter((i) => i.id !== started.id)].slice(0, 10));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Test run failed');
    }
  }, [id, selectedTestCommandId]);

  const handleRestore = useCallback(async () => {
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
  }, [id, appendSyntheticLog]);

  return {
    task, session, logs, runtime, approvals, changeSummaries, testRuns,
    testCommands, selectedTestCommandId, setSelectedTestCommandId,
    inputText, setInputText, actionError, denyMessages, setDenyMessages,
    pendingApprovalActionIds, isLive, pendingApprovals, latestDiff,
    handleStop, handleSendInput, handleApprove, handleDeny,
    handleDiffSummary, handleRunTests, handleRestore,
    appendSyntheticLog, upsertApproval
  };
}

function serverLogKey(sessionId: string, sequence: number): string {
  return `log:${sessionId}:${sequence}`;
}

function compareLogs(a: LogEntry, b: LogEntry): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.sequence - b.sequence;
}

function normalizeStoredDiffSummary(summary: GitChangeSummary): DiffSummaryResponse {
  return {
    id: summary.id, taskId: summary.taskId, sessionId: summary.sessionId,
    statusText: summary.statusText, filesChanged: summary.filesChanged,
    insertions: summary.insertions, deletions: summary.deletions,
    addedCount: summary.addedCount, modifiedCount: summary.modifiedCount,
    deletedCount: summary.deletedCount, renamedCount: summary.renamedCount,
    riskFlags: parseJson<string[]>(summary.riskFlagsJson, []),
    topFiles: parseJson<Array<{ path: string; insertions: number; deletions: number; status?: string }>>(summary.topFilesJson, []),
    createdAt: summary.createdAt
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
