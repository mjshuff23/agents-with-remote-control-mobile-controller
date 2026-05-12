import { Injectable } from '@nestjs/common';
import { AgentLog, TaskEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TaskEventEnvelope, TaskEventKind, TaskEventSeverity } from './events.gateway';

export interface AppendTaskEventInput<TName extends string = string, TData = unknown> {
  taskId: string;
  name: TName;
  kind: TaskEventKind;
  severity: TaskEventSeverity;
  data: TData;
  options?: {
    sessionId?: string;
    correlationId?: string;
  };
}

export interface ReplayTaskEventsInput {
  taskId: string;
  afterEventSeq?: number;
  afterLogSequence?: number;
  limit?: number;
}

export interface ReplayTaskEventsResult {
  events: TaskEventEnvelope[];
  logs: AgentLog[];
}

const DEFAULT_REPLAY_LIMIT = 500;
const MAX_REPLAY_LIMIT = 1000;

@Injectable()
export class TaskEventLedgerService {
  private readonly nextEventSequences = new Map<string, number>();
  private readonly eventWriteQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly prisma: PrismaService) {}

  async append<TName extends string, TData>(input: AppendTaskEventInput<TName, TData>): Promise<TaskEventEnvelope<TName, TData>> {
    const previousWrite = this.eventWriteQueues.get(input.taskId) ?? Promise.resolve();
    const currentWrite = previousWrite.catch(() => undefined).then(async () => {
      const seq = await this.nextSequence(input.taskId);
      const row = await this.prisma.taskEvent.create({
        data: {
          taskId: input.taskId,
          sessionId: input.options?.sessionId,
          seq,
          name: input.name,
          kind: input.kind,
          severity: input.severity,
          correlationId: input.options?.correlationId,
          dataJson: JSON.stringify(input.data)
        }
      });
      return toEnvelope<TName, TData>(row);
    });

    this.eventWriteQueues.set(input.taskId, currentWrite);
    return currentWrite as Promise<TaskEventEnvelope<TName, TData>>;
  }

  async replay(input: ReplayTaskEventsInput): Promise<ReplayTaskEventsResult> {
    const limit = clampLimit(input.limit);
    const session = await this.prisma.agentSession.findFirst({
      where: { taskId: input.taskId },
      orderBy: { createdAt: 'desc' }
    });
    const [events, logs] = await Promise.all([
      this.prisma.taskEvent.findMany({
        where: {
          taskId: input.taskId,
          seq: { gt: input.afterEventSeq ?? 0 }
        },
        orderBy: { seq: 'asc' },
        take: limit
      }),
      session
        ? this.prisma.agentLog.findMany({
          where: {
            sessionId: session.id,
            sequence: { gt: input.afterLogSequence ?? 0 }
          },
          orderBy: { sequence: 'asc' },
          take: limit
        })
        : Promise.resolve([])
    ]);

    return {
      events: events.map((event) => toEnvelope(event)),
      logs
    };
  }

  async latestSeq(taskId: string): Promise<number> {
    const cached = this.nextEventSequences.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const lastEvent = await this.prisma.taskEvent.findFirst({
      where: { taskId },
      orderBy: { seq: 'desc' }
    });
    const latest = lastEvent?.seq ?? 0;
    this.nextEventSequences.set(taskId, latest);
    return latest;
  }

  private async nextSequence(taskId: string): Promise<number> {
    const current = await this.latestSeq(taskId);
    const next = current + 1;
    this.nextEventSequences.set(taskId, next);
    return next;
  }
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || !limit || limit <= 0) {
    return DEFAULT_REPLAY_LIMIT;
  }
  return Math.min(limit, MAX_REPLAY_LIMIT);
}

function toEnvelope<TName extends string = string, TData = unknown>(row: TaskEvent): TaskEventEnvelope<TName, TData> {
  return {
    id: row.id,
    seq: row.seq,
    taskId: row.taskId,
    sessionId: row.sessionId ?? undefined,
    name: row.name as TName,
    kind: row.kind as TaskEventKind,
    severity: row.severity as TaskEventSeverity,
    correlationId: row.correlationId ?? undefined,
    at: row.createdAt.toISOString(),
    data: parseData<TData>(row.dataJson)
  };
}

function parseData<TData>(dataJson: string): TData {
  try {
    return JSON.parse(dataJson) as TData;
  } catch {
    return dataJson as TData;
  }
}
