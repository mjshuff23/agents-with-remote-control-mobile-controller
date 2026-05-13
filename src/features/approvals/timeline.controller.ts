import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ControllerSecretGuard } from '../../common/guards/controller-secret.guard';
import { ApprovalAuditSyncService } from './approval-audit-sync.service';

@Controller('tasks')
@UseGuards(ControllerSecretGuard)
export class TimelineController {
  constructor(private readonly approvalAuditSync: ApprovalAuditSyncService) {}

  @Get(':id/timeline')
  async getTimeline(@Param('id') taskId: string) {
    return this.approvalAuditSync.getTaskTimeline(taskId);
  }
}
