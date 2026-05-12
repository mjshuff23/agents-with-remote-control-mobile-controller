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

const SYNC_EVENT_STATUSES: Record<SyncEventStatus, true> = {
  pending: true,
  running: true,
  succeeded: true,
  failed: true,
  retryable: true,
  skipped: true,
};

function isValidSyncEventStatus(value: string): value is SyncEventStatus {
  return value in SYNC_EVENT_STATUSES;
}

const VALID_TRANSITIONS: Record<SyncEventStatus, SyncEventStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['succeeded', 'failed', 'retryable'],
  retryable: ['running'],
  succeeded: [],
  failed: [],
  skipped: [],
};

const SENSITIVE_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{85}/g,
  /lin_api_[a-zA-Z0-9]{40}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /-----BEGIN [A-Z ]+-----/g,
  /\$\{[A-Z_]+}/g,
  /process\.env\.\w+/g,
  /token[=:]["']?[a-zA-Z0-9_\-]{16,}["']?/gi,
  /secret[=:]["']?[a-zA-Z0-9_\-]{16,}["']?/gi,
];

@Injectable()
export class SyncEventService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrReuse(input: CreateOrReuseSyncEventInput): Promise<SyncEvent> {
    try {
      return await this.prisma.syncEvent.create({
        data: {
          taskId: input.taskId,
          sessionId: input.sessionId,
          provider: input.provider,
          action: input.action,
          targetId: input.targetId,
          status: 'pending',
        },
      });
    } catch (error: unknown) {
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
      throw error;
    }
  }

  async markRunning(id: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'running');
  }

  async markSucceeded(id: string, externalId?: string, url?: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'succeeded', { externalId, url });
  }

  async markFailed(id: string, errorCategory: string, errorMessage: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'failed', {
      errorCategory,
      errorMessage: sanitizeErrorMessage(errorMessage),
    });
  }

  async markRetryable(id: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'retryable');
  }

  async markSkipped(id: string): Promise<SyncEvent> {
    return this.transitionTo(id, 'skipped');
  }

  async listForTask(taskId: string, limit: number = 50): Promise<SyncEvent[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    return this.prisma.syncEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
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
    if (!isValidSyncEventStatus(current.status)) {
      throw new Error(`SyncEvent ${id} has unknown status: "${current.status}"`);
    }
    const from = current.status as SyncEventStatus;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(target)) {
      throw new Error(
        `Invalid SyncEvent transition: ${from} -> ${target}. Allowed: ${allowed.join(', ') || 'none'}`,
      );
    }

    const safeExtra = sanitizeExtra(extra);
    const result = await this.prisma.syncEvent.updateMany({
      where: { id, status: from },
      data: { status: target, ...safeExtra },
    });
    if (result.count === 0) {
      const stale = await this.prisma.syncEvent.findUnique({ where: { id } });
      throw new Error(
        `SyncEvent ${id} concurrent transition: expected "${from}", found "${stale?.status ?? 'deleted'}"`,
      );
    }
    return this.prisma.syncEvent.findUnique({ where: { id } }) as Promise<SyncEvent>;
  }
}

function sanitizeErrorMessage(msg: string): string {
  let safe = msg;
  for (const pattern of SENSITIVE_PATTERNS) {
    safe = safe.replace(pattern, '[REDACTED]');
  }
  return safe;
}

function sanitizeExtra(
  obj: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!obj) return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (key === 'status') continue;
    if (key === 'errorMessage' && typeof value === 'string') {
      cleaned[key] = sanitizeErrorMessage(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
