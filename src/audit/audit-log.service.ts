import { Injectable } from '@nestjs/common';
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

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async append(input: AppendAuditInput) {
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
        metadataJson: input.metadata === undefined ? undefined : JSON.stringify(input.metadata)
      }
    });
  }
}
