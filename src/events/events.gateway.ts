import { Injectable, Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { AppConfigService } from '../config/app-config.service';

export type TaskEventKind = 'lifecycle' | 'log' | 'approval' | 'git' | 'diff' | 'test' | 'security' | 'controller';
export type TaskEventSeverity = 'info' | 'warn' | 'error';

export interface TaskEventEnvelope<TName extends string = string, TData = unknown> {
  id: string;
  seq: number;
  taskId: string;
  sessionId?: string;
  name: TName;
  kind: TaskEventKind;
  severity: TaskEventSeverity;
  correlationId?: string;
  at: string;
  data: TData;
}

@Injectable()
@WebSocketGateway({ cors: { origin: '*' } })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);
  private readonly nextEventSequences = new Map<string, number>();

  @WebSocketServer()
  private server?: Server;

  constructor(private readonly config: AppConfigService) {}

  afterInit(server: Server): void {
    this.server = server;
    if (!this.config.controllerSecret) {
      this.logger.error(
        'CONTROLLER_SECRET is not set — all WebSocket connections will be rejected. ' +
        'Set this environment variable to enable the controller UI.'
      );
    }
  }

  handleConnection(client: Socket): void {
    const secret = this.config.controllerSecret;
    if (!secret || client.handshake.auth.token !== secret) {
      client.disconnect(true);
    }
  }

  @SubscribeMessage('subscribe')
  subscribe(client: Socket, payload: { taskId: string }): { ok: true } {
    client.join(`task:${payload.taskId}`);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(client: Socket, payload: { taskId: string }): void {
    client.leave(`task:${payload.taskId}`);
  }

  emitToTask(taskId: string, event: string, payload: unknown): void {
    this.server?.to(`task:${taskId}`).emit(event, payload);
  }

  emitEnvelopeToTask<TName extends string, TData>(
    taskId: string,
    name: TName,
    kind: TaskEventKind,
    severity: TaskEventSeverity,
    data: TData,
    options: { sessionId?: string; correlationId?: string } = {}
  ): TaskEventEnvelope<TName, TData> {
    const envelope: TaskEventEnvelope<TName, TData> = {
      id: randomUUID(),
      seq: this.nextEnvelopeSequence(taskId),
      taskId,
      sessionId: options.sessionId,
      name,
      kind,
      severity,
      correlationId: options.correlationId,
      at: new Date().toISOString(),
      data
    };
    this.emitToTask(taskId, name, envelope);
    return envelope;
  }

  private nextEnvelopeSequence(taskId: string): number {
    const next = (this.nextEventSequences.get(taskId) ?? 0) + 1;
    this.nextEventSequences.set(taskId, next);
    return next;
  }
}
