'use client';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

// Module-level singleton so all components share one connection.
let _socket: Socket | null = null;

function getSocket(): Socket {
  if (!_socket) {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3000';
    const secret = process.env.NEXT_PUBLIC_CONTROLLER_SECRET ?? '';
    _socket = io(wsUrl, {
      auth: { token: secret },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      transports: ['websocket']
    });
  }
  return _socket;
}

export interface TaskSocketHandlers {
  onLog?: (data: { type: string; content: string; sequence: number }) => void;
  onStarted?: (data: unknown) => void;
  onCompleted?: (data: { exitCode: number; status: string }) => void;
}

export function useTaskSocket(taskId: string, handlers: TaskSocketHandlers): void {
  // Keep handlers ref stable so the effect doesn't re-run on every render
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const socket = getSocket();
    socket.emit('subscribe', { taskId });

    const onLog = (data: { type: string; content: string; sequence: number }) =>
      ref.current.onLog?.(data);
    const onStarted = (data: unknown) => ref.current.onStarted?.(data);
    const onCompleted = (data: { exitCode: number; status: string }) =>
      ref.current.onCompleted?.(data);

    socket.on('agent.log', onLog);
    socket.on('task.started', onStarted);
    socket.on('task.completed', onCompleted);

    return () => {
      socket.off('agent.log', onLog);
      socket.off('task.started', onStarted);
      socket.off('task.completed', onCompleted);
      socket.emit('unsubscribe', { taskId });
    };
  }, [taskId]);
}
