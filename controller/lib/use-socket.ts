'use client';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ApprovalRequest, DiffSummaryResponse, TaskEventEnvelope, TestRunSummary } from './api';

type GlobalWithSocket = typeof globalThis & {
  __CONTROLLER_SOCKET__?: Socket;
  __CONTROLLER_SOCKET_CLEANUP_ADDED__?: boolean;
};

// Module-level reference. Pinned to globalThis so Next.js fast refresh
// (which re-executes modules but keeps the JS heap) reuses the same socket.
let _socket: Socket | null = null;

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
        // eslint-disable-next-line no-console
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
  onLog?: (data: { type: string; content: string; sequence: number }) => void;
  onStarted?: (data: unknown) => void;
  onCompleted?: (data: { exitCode: number; status: string }) => void;
  onApprovalRequested?: (event: TaskEventEnvelope<'approval.requested', ApprovalRequest>) => void;
  onApprovalResolved?: (event: TaskEventEnvelope<'approval.resolved', ApprovalRequest>) => void;
  onPolicyViolation?: (event: TaskEventEnvelope<'policy.violation', ApprovalRequest>) => void;
  onDiffSummary?: (event: TaskEventEnvelope<'diff.summary', DiffSummaryResponse>) => void;
  onTestStarted?: (event: TaskEventEnvelope<'test.started', { id: string; commandId: string; label: string; command: string[] }>) => void;
  onTestLog?: (event: TaskEventEnvelope<'test.log', { testRunId: string; stream: string; content: string }>) => void;
  onTestCompleted?: (event: TaskEventEnvelope<'test.completed', TestRunSummary>) => void;
}

export function useTaskSocket(taskId: string, handlers: TaskSocketHandlers): void {
  // Keep handlers ref stable so the effect doesn't re-run on every render
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const socket = getSocket();
    let active = true;
    // Populated once the subscribe ack resolves; called in cleanup.
    let cleanupListeners: (() => void) | null = null;

    // Await the server-side room join before attaching listeners.
    // This closes the race window where task.completed could fire before
    // the client has actually joined the task room.
    void socket.emitWithAck('subscribe', { taskId }).then(() => {
      if (!active) {
        // Component unmounted before ack — leave the room immediately.
        socket.emit('unsubscribe', { taskId });
        return;
      }

      // Filter by taskId so events from a previous task don't leak into a new
      // one during App Router transitions where old/new pages briefly coexist.
      const onLog = (data: { taskId: string; type: string; content: string; sequence: number }) => {
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

      cleanupListeners = () => {
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
        socket.emit('unsubscribe', { taskId });
      };
    });

    return () => {
      active = false;
      // If ack already resolved, cleanupListeners is populated and handles everything.
      // If ack is still pending, the .then() branch handles unsubscribe on resolution.
      cleanupListeners?.();
    };
  }, [taskId]);
}
