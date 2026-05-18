import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../features/audit/audit-log.service';
import { canonicalizeArgs, sanitizeToolArguments } from '../permissions/mcp-permission.policy';
import type { McpAuditDecider, McpAuditOutcome, RecordMcpAuditInput } from './mcp-audit.types';

/** Maximum byte length for sanitized previews stored in McpAuditLog. */
const PREVIEW_MAX_BYTES = 4096;
const PREVIEW_TRUNCATION_SUFFIX = '…[truncated]';

/**
 * Owns all McpAuditLog writes.
 *
 * One row per McpToolCallService.execute() invocation, written at the terminal
 * branch. argumentHash covers the raw (pre-sanitization) canonical args so the
 * hash is reproducible from the original call. sanitizedArgumentPreview is a
 * separate artifact that never contains raw secret values.
 *
 * Also writes a lightweight shadow event to the generic AuditLog (kind:
 * 'mcp.tool_call') for timeline/replay consumers. The shadow carries NO preview
 * data — only enough fields for timeline display.
 */
@Injectable()
export class McpAuditService {
  private readonly logger = new Logger(McpAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService
  ) {}

  /**
   * Hash a value using SHA-256 of its canonicalized JSON representation.
   * Returns null for null/undefined inputs (no execution occurred).
   * Static so McpToolCallService can compute hashes without a service reference.
   */
  static hashValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const canonical = canonicalizeArgs(value);
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  }

  /**
   * Append one McpAuditLog row and a lightweight AuditLog shadow event.
   * Never throws — audit failures are logged and swallowed to protect the
   * main execution path.
   */
  async record(input: RecordMcpAuditInput): Promise<void> {
    const argumentHash = McpAuditService.hashValue(input.args) as string; // args always present
    const resultHash = McpAuditService.hashValue(input.result ?? null);
    const sanitizedArgumentPreview = this.buildPreview(input.args) as string;
    const sanitizedResultPreview = this.buildPreview(input.result ?? null);
    const decider = this.resolveDecider(input.outcome);

    try {
      await this.prisma.mcpAuditLog.create({
        data: {
          taskId: input.taskId,
          sessionId: input.sessionId,
          approvalRequestId: input.approvalRequestId,
          serverId: input.serverId,
          serverDisplayName: input.serverDisplayName,
          toolName: input.toolName,
          permissionLevel: input.permissionLevel,
          toolRisk: input.toolRisk,
          decider,
          outcome: input.outcome,
          argumentHash,
          resultHash,
          sanitizedArgumentPreview,
          sanitizedResultPreview,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          errorCategory: input.errorCategory
        }
      });
    } catch (err) {
      this.logger.error(
        `McpAuditLog write failed for ${input.serverId}:${input.toolName} — ${err instanceof Error ? err.message : String(err)}`
      );
    }

    await this.writeShadow(input, decider).catch((err) => {
      this.logger.warn(
        `McpAuditLog shadow write failed for ${input.serverId}:${input.toolName} — ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  private resolveDecider(outcome: McpAuditOutcome): McpAuditDecider {
    if (outcome === 'auto_allow' || outcome === 'blocked') return 'policy';
    if (outcome === 'approved' || outcome === 'denied') return 'user';
    return 'system'; // expired | failed
  }

  /**
   * Write a minimal projection to the generic AuditLog for timeline consumers.
   * Carries NO preview data, NO hashes — only enough to identify the event.
   */
  private async writeShadow(input: RecordMcpAuditInput, decider: McpAuditDecider): Promise<void> {
    await this.audit.append({
      taskId: input.taskId,
      sessionId: input.sessionId,
      approvalRequestId: input.approvalRequestId,
      kind: 'mcp.tool_call',
      actionType: 'mcp.tool_call',
      riskLevel: input.toolRisk,
      decision: input.outcome,
      message: `MCP tool call ${input.outcome}: ${input.serverDisplayName}:${input.toolName} (decider: ${decider})`,
      // metadata intentionally contains only non-sensitive identifiers — NO previews
      metadata: { serverId: input.serverId, toolName: input.toolName, outcome: input.outcome, decider }
    });
  }

  /** Build a sanitized, byte-capped JSON preview string. Returns null for null/undefined. */
  private buildPreview(value: unknown): string | null {
    if (value === null || value === undefined) return null;

    let sanitized: unknown;
    if (typeof value === 'object' && !Array.isArray(value)) {
      sanitized = sanitizeToolArguments(value as Record<string, unknown>);
    } else {
      sanitized = value;
    }

    const json = JSON.stringify(sanitized);
    if (Buffer.byteLength(json) <= PREVIEW_MAX_BYTES) return json;

    // Truncate to fit within PREVIEW_MAX_BYTES including suffix
    const suffixBytes = Buffer.byteLength(PREVIEW_TRUNCATION_SUFFIX);
    const targetBytes = PREVIEW_MAX_BYTES - suffixBytes;
    const buf = Buffer.from(json);
    return buf.slice(0, targetBytes).toString('utf8') + PREVIEW_TRUNCATION_SUFFIX;
  }
}
