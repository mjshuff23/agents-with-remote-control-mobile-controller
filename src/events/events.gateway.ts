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

  @SubscribeMessage('unsubscribe')
  unsubscribe(client: Socket, payload: { taskId: string }): void {
    client.leave(`task:${payload.taskId}`);
  }

  emitToTask(taskId: string, event: string, payload: unknown): void {
    this.server?.to(`task:${taskId}`).emit(event, payload);
  }

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

  async emitEnvelopeToTask<TName extends string, TData>(
    taskId: string,
    name: TName,
    kind: TaskEventKind,
    severity: TaskEventSeverity,
    data: TData,
    options: { sessionId?: string; correlationId?: string } = {}
  ): Promise<TaskEventEnvelope<TName, TData> | undefined> {
    const envelope = await this.persistEnvelope(taskId, name, kind, severity, data, options);
    this.emitToTask(taskId, name, envelope);
    return envelope;
  }

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
