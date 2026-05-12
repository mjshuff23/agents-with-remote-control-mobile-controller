import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { AgentSessionsService } from '../agent-sessions/agent-sessions.service';
import { ControllerSecretGuard } from '../common/guards/controller-secret.guard';
import { ApprovalDecisionDto } from '../approvals/dto/approval-decision.dto';

/** REST controller for approving or denying pending approval requests. */
@Controller('approvals')
@UseGuards(ControllerSecretGuard)
export class ApprovalActionsController {
  constructor(private readonly agentSessions: AgentSessionsService) {}

  /** Approve a pending approval. Returns 202. */
  @Post(':id/approve')
  @HttpCode(202)
  async approve(@Param('id') id: string, @Body() body: ApprovalDecisionDto) {
    return this.agentSessions.resolveApproval(id, 'approved', body.message);
  }

  /** Deny a pending approval. Returns 202. */
  @Post(':id/deny')
  @HttpCode(202)
  async deny(@Param('id') id: string, @Body() body: ApprovalDecisionDto) {
    return this.agentSessions.resolveApproval(id, 'denied', body.message);
  }
}
