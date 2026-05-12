import { Injectable } from '@nestjs/common';
import type { SyncEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type SyncEventStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'retryable' | 'skipped';

export interface CreateOrReuseSyncEventInput {
  taskId: string;
  sessionId?: string;
  provider: string;
  action: string;
  targetId: string;
}

const VALID_TRANSITIONS: Record<SyncEventStatus, SyncEventStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['succeeded', 'failed', 'retryable'],
  retryable: ['running'],
  succeeded: [],
  failed: [],
  skipped: [],
};

@Injectable()
export class SyncEventService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrReuse(input: CreateOrReuseSyncEventInput): Promise<SyncEvent> {
    const existing = await this.prisma.syncEvent.findUnique({
      where: {
        taskId_provider_targetId_action: {
          taskId: input.taskId,
          provider: input.provider,
          targetId: input.targetId,
          action: input.action,
        },
      },
    });
    if (existing) return existing;

    return this.prisma.syncEvent.create({
      data: {
        taskId: input.taskId,
        sessionId: input.sessionId,
        provider: input.provider,
        action: input.action,
        targetId: input.targetId,
        status: 'pending',
      },
    });
  }

  async markRunning(id: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'running');
  }

  async markSucceeded(id: string, externalId?: string, url?: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'succeeded', { externalId, url });
  }

  async markFailed(id: string, errorCategory: string, errorMessage: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'failed', { errorCategory, errorMessage });
  }

  async markRetryable(id: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'retryable');
  }

  async markSkipped(id: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'skipped');
  }

  async listForTask(taskId: string): Promise<SyncEvent[]> {
    return this.prisma.syncEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getLastForAction(taskId: string, provider: string, action: string, targetId: string): Promise<SyncEvent | null> {
    return this.prisma.syncEvent.findUnique({
      where: {
        taskId_provider_targetId_action: { taskId, provider, targetId, action },
      },
    });
  }

  private async transitionTo(
    id: string,
    target: SyncEventStatus,
    extra?: Partial<Pick<SyncEvent, 'externalId' | 'url' | 'errorCategory' | 'errorMessage'>>,
  ): Promise<SyncEvent> {
    const current = await this.prisma.syncEvent.findUnique({ where: { id } });
    if (!current) {
      throw new Error(`SyncEvent ${id} not found`);
    }
    const allowed = VALID_TRANSITIONS[current.status as SyncEventStatus];
    if (!allowed.includes(target)) {
      throw new Error(
        `Invalid SyncEvent transition: ${current.status} -> ${target}. Allowed: ${allowed.join(', ') || 'none'}`,
      );
    }
    return this.prisma.syncEvent.update({
      where: { id },
      data: {
        status: target,
        ...extra,
      },
    });
  }
}
