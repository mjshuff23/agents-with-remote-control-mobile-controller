'use client';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ApprovalRequest, DiffSummaryResponse, TaskEventEnvelope, TaskReplayResponse, TestRunSummary } from './api';

type GlobalWithSocket = typeof globalThis & {
  __CONTROLLER_SOCKET__?: Socket;
  __CONTROLLER_SOCKET_CLEANUP_ADDED__?: boolean;
};

// Module-level reference. Pinned to globalThis so Next.js fast refresh
// (which re-executes modules but keeps the JS heap) reuses the same socket.
let _socket: Socket | null = null;

/**
 * Return the singleton WebSocket connection, creating it on first call.
 * Pinned to globalThis so Next.js fast refresh reuses the same socket
 * across module reloads.
 *
 * @returns The singleton Socket.io client instance.
 */
function getSocket(): Socket {
  const g = globalThis as GlobalWithSocket;

  // Reuse an already-connected socket that survived a module reload.
  if (!_socket && g.__CONTROLLER_SOCKET__?.connected) {
    _socket = g.__CONTROLLER_SOCKET__;
  }

  if (!_socket) {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3000';
    const secret = process.env.NEXT_PUBLIC_CONTROLLER_SECRET;

    if (!secret) {
      const msg =
        'Missing NEXT_PUBLIC_CONTROLLER_SECRET — WebSocket auth will fail. ' +
        'Ensure it is set and matches CONTROLLER_SECRET on the server.';
      if (process.env.NODE_ENV === 'production') {
        throw new Error(msg);
      } else {
        console.error(msg);
      }
    }

    _socket = io(wsUrl, {
      auth: { token: secret ?? '' },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      transports: ['websocket']
    });

    g.__CONTROLLER_SOCKET__ = _socket;

    if (typeof window !== 'undefined' && !g.__CONTROLLER_SOCKET_CLEANUP_ADDED__) {
      window.addEventListener('beforeunload', () => {
        const gs = globalThis as GlobalWithSocket;
        gs.__CONTROLLER_SOCKET__?.close();
        gs.__CONTROLLER_SOCKET__ = undefined;
        gs.__CONTROLLER_SOCKET_CLEANUP_ADDED__ = false;
        _socket = null;
      });
      g.__CONTROLLER_SOCKET_CLEANUP_ADDED__ = true;
    }
  }

  return _socket;
}

export interface TaskSocketHandlers {
  onLog?: (data: { sessionId?: string; type: string; content: string; sequence: number }) => void;
  onStarted?: (data: unknown) => void;
  onCompleted?: (data: { exitCode: number; status: string }) => void;
  onApprovalRequested?: (event: TaskEventEnvelope<'approval.requested', ApprovalRequest>) => void;
  onApprovalResolved?: (event: TaskEventEnvelope<'approval.resolved', ApprovalRequest>) => void;
  onPolicyViolation?: (event: TaskEventEnvelope<'policy.violation', ApprovalRequest>) => void;
  onDiffSummary?: (event: TaskEventEnvelope<'diff.summary', DiffSummaryResponse>) => void;
  onTestStarted?: (event: TaskEventEnvelope<'test.started', { id: string; commandId: string; label: string; command: string[] }>) => void;
  onTestLog?: (event: TaskEventEnvelope<'test.log', { testRunId: string; stream: string; content: string }>) => void;
  onTestCompleted?: (event: TaskEventEnvelope<'test.completed', TestRunSummary>) => void;
  onSessionDormant?: (event: TaskEventEnvelope<'session.dormant', { sessionId: string; checkpointId: string; reason: string }>) => void;
  onSessionRestored?: (event: TaskEventEnvelope<'session.restored', { sessionId: string; checkpointId: string; restoreMode: string }>) => void;
  getReplayCursor?: () => { afterEventSeq: number; afterLogSequence: number };
  onReplay?: (replay: Pick<TaskReplayResponse, 'events' | 'logs'>) => void;
  onReconnected?: () => void;
}

/**
 * Subscribe to real-time events for a given task over WebSocket.
 *
 * Attaches event handlers, joins the server-side room, and replays missed
 * events on (re)connect. Automatically cleans up on unmount or taskId change.
 *
 * @param taskId  - The task to subscribe to.
 * @param handlers - Callback map for log, start, completion, approval, diff,
 *                   test, and reconnect events.
 */
export function useTaskSocket(taskId: string, handlers: TaskSocketHandlers): void {
  // Keep handlers ref stable so the effect doesn't re-run on every render
  const ref = useRef(handlers);
  useEffect(() => { ref.current = handlers; }, [handlers]);

  useEffect(() => {
    const socket = getSocket();
    let active = true;
    // Track whether we've ever had a successful connection in this effect lifetime.
    // The first 'connect' event is the initial connection; subsequent ones are reconnects.
    let hasConnectedOnce = socket.connected;

    // All event handlers defined upfront so they can be registered immediately
    // and cleaned up without needing to wait for the subscribe ack.
    const onLog = (data: { taskId: string; sessionId?: string; type: string; content: string; sequence: number }) => {
      if (data.taskId === taskId) ref.current.onLog?.(data);
    };
    const onStarted = (data: { taskId: string }) => {
      if (data.taskId === taskId) ref.current.onStarted?.(data);
    };
    const onCompleted = (data: { taskId: string; exitCode: number; status: string }) => {
      if (data.taskId === taskId) ref.current.onCompleted?.(data);
    };
    const onApprovalRequested = (event: TaskEventEnvelope<'approval.requested', ApprovalRequest>) => {
      if (event.taskId === taskId) ref.current.onApprovalRequested?.(event);
    };
    const onApprovalResolved = (event: TaskEventEnvelope<'approval.resolved', ApprovalRequest>) => {
      if (event.taskId === taskId) ref.current.onApprovalResolved?.(event);
    };
    const onPolicyViolation = (event: TaskEventEnvelope<'policy.violation', ApprovalRequest>) => {
      if (event.taskId === taskId) ref.current.onPolicyViolation?.(event);
    };
    const onDiffSummary = (event: TaskEventEnvelope<'diff.summary', DiffSummaryResponse>) => {
      if (event.taskId === taskId) ref.current.onDiffSummary?.(event);
    };
    const onTestStarted = (event: TaskEventEnvelope<'test.started', { id: string; commandId: string; label: string; command: string[] }>) => {
      if (event.taskId === taskId) ref.current.onTestStarted?.(event);
    };
    const onTestLog = (event: TaskEventEnvelope<'test.log', { testRunId: string; stream: string; content: string }>) => {
      if (event.taskId === taskId) ref.current.onTestLog?.(event);
    };
    const onTestCompleted = (event: TaskEventEnvelope<'test.completed', TestRunSummary>) => {
      if (event.taskId === taskId) ref.current.onTestCompleted?.(event);
    };
    const onSessionDormant = (event: TaskEventEnvelope<'session.dormant', { sessionId: string; checkpointId: string; reason: string }>) => {
      if (event.taskId === taskId) ref.current.onSessionDormant?.(event);
    };
    const onSessionRestored = (event: TaskEventEnvelope<'session.restored', { sessionId: string; checkpointId: string; restoreMode: string }>) => {
      if (event.taskId === taskId) ref.current.onSessionRestored?.(event);
    };

    // Attach all event handlers immediately. Events are filtered client-side
    // by taskId, so there is no risk of cross-task bleed. Attaching before the
    // subscribe ack means we can't miss an event that fires in the RTT window.
    socket.on('agent.log', onLog);
    socket.on('task.started', onStarted);
    socket.on('task.completed', onCompleted);
    socket.on('approval.requested', onApprovalRequested);
    socket.on('approval.resolved', onApprovalResolved);
    socket.on('policy.violation', onPolicyViolation);
    socket.on('diff.summary', onDiffSummary);
    socket.on('test.started', onTestStarted);
    socket.on('test.log', onTestLog);
    socket.on('test.completed', onTestCompleted);
    socket.on('session.dormant', onSessionDormant);
    socket.on('session.restored', onSessionRestored);

    // Join the server-side room. socket.io rooms are server-side only and are
    // lost on every disconnect, so this must be repeated on every reconnect.
    const joinRoom = () => {
      if (!active) return;
      const cursors = ref.current.getReplayCursor?.() ?? { afterEventSeq: 0, afterLogSequence: 0 };
      void socket
        .timeout(5_000)
        .emitWithAck('subscribe', { taskId, ...cursors })
        .then((ack: { replay?: Pick<TaskReplayResponse, 'events' | 'logs'> }) => {
          if (!active || !ack.replay) return;
          ref.current.onReplay?.(ack.replay);
        })
        .catch(() => {});
    };

    // Re-subscribe on every connect event (initial + reconnects).
    // On reconnect, also notify the page so it can re-fetch state to recover
    // any events that were emitted while the socket was disconnected.
    const onConnect = () => {
      if (!active) return;
      joinRoom();
      if (hasConnectedOnce) {
        ref.current.onReconnected?.();
      }
      hasConnectedOnce = true;
    };
    socket.on('connect', onConnect);

    // Initial room join. If the socket isn't connected yet, socket.io queues
    // this and sends it automatically on first connect.
    joinRoom();

    return () => {
      active = false;
      socket.off('agent.log', onLog);
      socket.off('task.started', onStarted);
      socket.off('task.completed', onCompleted);
      socket.off('approval.requested', onApprovalRequested);
      socket.off('approval.resolved', onApprovalResolved);
      socket.off('policy.violation', onPolicyViolation);
      socket.off('diff.summary', onDiffSummary);
      socket.off('test.started', onTestStarted);
      socket.off('test.log', onTestLog);
      socket.off('test.completed', onTestCompleted);
      socket.off('session.dormant', onSessionDormant);
      socket.off('session.restored', onSessionRestored);
      socket.off('connect', onConnect);
      socket.emit('unsubscribe', { taskId });
    };
  }, [taskId]);
}
