import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

export interface AppendAuditInput {
  taskId?: string;
  sessionId?: string;
  approvalRequestId?: string;
  kind: string;
  actionType?: string;
  riskLevel?: string;
  ruleMatched?: string;
  decision?: string;
  message: string;
  metadata?: unknown;
}

/** Writes structured audit records to the database for security and compliance tracking. */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Append an audit record for an action, decision, or policy event. */
  async append(input: AppendAuditInput) {
    const metadataJson = this.serializeMetadata(input.metadata);
    return this.prisma.auditLog.create({
      data: {
        taskId: input.taskId,
        sessionId: input.sessionId,
        approvalRequestId: input.approvalRequestId,
        kind: input.kind,
        actionType: input.actionType,
        riskLevel: input.riskLevel,
        ruleMatched: input.ruleMatched,
        decision: input.decision,
        message: input.message,
        metadataJson
      }
    });
  }

  /** Safely serialize metadata to JSON, falling back on error. */
  private serializeMetadata(metadata: unknown): string | undefined {
    if (metadata === undefined) {
      return undefined;
    }
    try {
      return JSON.stringify(metadata);
    } catch (error) {
      this.logger.warn(`Audit metadata could not be serialized: ${error instanceof Error ? error.message : String(error)}`);
      return JSON.stringify({ error: 'unserializable metadata' });
    }
  }
}
