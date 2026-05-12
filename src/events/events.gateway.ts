import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { AppConfigService } from '../config/app-config.service';
import { ReplayTaskEventsResult, TaskEventLedgerService } from './task-event-ledger.service';

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

export interface SubscribePayload {
  taskId: string;
  afterEventSeq?: number;
  afterLogSequence?: number;
  limit?: number;
}

export interface SubscribeAck {
  ok: true;
  replay?: ReplayTaskEventsResult;
}

/** WebSocket gateway for real-time task event streaming with auth via CONTROLLER_SECRET. */
@Injectable()
@WebSocketGateway({ cors: { origin: '*' } })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  private server?: Server;

  constructor(
    private readonly config: AppConfigService,
    @Optional() private readonly ledger?: TaskEventLedgerService
  ) {}

  /** Log a warning if CONTROLLER_SECRET is missing so clients cannot authenticate. */
  afterInit(server: Server): void {
    this.server = server;
    if (!this.config.controllerSecret) {
      this.logger.error(
        'CONTROLLER_SECRET is not set — all WebSocket connections will be rejected. ' +
        'Set this environment variable to enable the controller UI.'
      );
    }
  }

  /** Disconnect clients that fail to provide a valid controller secret token. */
  handleConnection(client: Socket): void {
    const secret = this.config.controllerSecret;
    if (!secret || client.handshake.auth.token !== secret) {
      client.disconnect(true);
    }
  }

  /** Join a task room and optionally replay missed events/logs. */
  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, payload: SubscribePayload): Promise<SubscribeAck> {
    client.join(`task:${payload.taskId}`);
    const replay = this.ledger
      ? await this.ledger.replay({
        taskId: payload.taskId,
        afterEventSeq: payload.afterEventSeq,
        afterLogSequence: payload.afterLogSequence,
        limit: payload.limit
      })
      : undefined;
    return replay ? { ok: true, replay } : { ok: true };
  }

  /** Leave a task room. */
  @SubscribeMessage('unsubscribe')
  unsubscribe(client: Socket, payload: { taskId: string }): void {
    client.leave(`task:${payload.taskId}`);
  }

  /** Broadcast a raw event to all clients subscribed to a task room. */
  emitToTask(taskId: string, event: string, payload: unknown): void {
    this.server?.to(`task:${taskId}`).emit(event, payload);
  }

  /**
   * Emit an event to a task room, persisting it first. The raw `data` is
   * emitted on the wire, not the envelope (compatibility shim for older clients).
   */
  async emitCompatibilityEventToTask<TName extends string, TData>(
    taskId: string,
    name: TName,
    kind: TaskEventKind,
    severity: TaskEventSeverity,
    data: TData,
    options: { sessionId?: string; correlationId?: string } = {}
  ): Promise<TaskEventEnvelope<TName, TData> | undefined> {
    const envelope = await this.persistEnvelope(taskId, name, kind, severity, data, options);
    this.emitToTask(taskId, name, data);
    return envelope;
  }

  /**
   * Emit an event to a task room, persisting it and sending the full
   * TaskEventEnvelope on the wire (with seq, id, timestamps).
   */
  async emitEnvelopeToTask<TName extends string, TData>(
    taskId: string,
    name: TName,
    kind: TaskEventKind,
    severity: TaskEventSeverity,
    data: TData,
    options: { sessionId?: string; correlationId?: string } = {}
  ): Promise<TaskEventEnvelope<TName, TData> | undefined> {
    const persisted = await this.persistEnvelope(taskId, name, kind, severity, data, options);
    // When ledger is absent (e.g. tests), build a synthetic envelope so consumers
    // always receive a consistent TaskEventEnvelope shape with seq/data fields.
    const envelope: TaskEventEnvelope<TName, TData> = persisted ?? {
      id: randomUUID(),
      seq: 0,
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
    return persisted;
  }

  /** Persist an event envelope via the ledger service if available. */
  private async persistEnvelope<TName extends string, TData>(
    taskId: string,
    name: TName,
    kind: TaskEventKind,
    severity: TaskEventSeverity,
    data: TData,
    options: { sessionId?: string; correlationId?: string }
  ): Promise<TaskEventEnvelope<TName, TData> | undefined> {
    if (!this.ledger) {
      return undefined;
    }
    return this.ledger.append({ taskId, name, kind, severity, data, options });
  }
}
