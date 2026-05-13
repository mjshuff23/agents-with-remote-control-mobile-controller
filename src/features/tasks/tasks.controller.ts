import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { ControllerSecretGuard } from '../../common/guards/controller-secret.guard';
import { RunTestDto } from '../test-runs/dto/run-test.dto';
import { CommitTaskDto } from './dto/commit-task.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { PushTaskDto } from './dto/push-task.dto';
import { SendInputDto } from './dto/send-input.dto';
import { TasksService } from './tasks.service';

/** REST controller for task CRUD operations (create, list, get, stop, input) and sub-resources (approvals, diffs, tests). */
@Controller('tasks')
@UseGuards(ControllerSecretGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** Create a new task. Returns 202 Accepted with Location header. */
  @Post()
  async createTask(@Body() body: CreateTaskDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.tasks.createTask(body);
    response.status(202).location(`/tasks/${result.task.id}`);
    return result;
  }

  /** List the 50 most recent tasks. */
  @Get()
  async listTasks() {
    return this.tasks.listTasks();
  }

  /** Get full task details including session, logs, events, approvals, diffs, test runs. */
  @Get(':id')
  async getTask(@Param('id') id: string) {
    return this.tasks.getTask(id);
  }

  /** Replay events and logs after cursor positions for durable reconnect. */
  @Get(':id/replay')
  async replayTask(
    @Param('id') id: string,
    @Query('afterEventSeq') afterEventSeq?: string,
    @Query('afterLogSequence') afterLogSequence?: string,
    @Query('limit') limit?: string
  ) {
    return this.tasks.replayTask(id, {
      afterEventSeq: parseCursor(afterEventSeq),
      afterLogSequence: parseCursor(afterLogSequence),
      limit: parseCursor(limit)
    });
  }

  /** Stop a running task. Returns 202 if accepted, 200 if already terminal. */
  @Post(':id/stop')
  async stopTask(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.tasks.stopTask(id);
    response.status(result.accepted ? 202 : 200);
    return result;
  }

  /** Send stdin text to a running agent process. Returns 202. */
  @Post(':id/input')
  @HttpCode(202)
  async sendInput(@Param('id') id: string, @Body() body: SendInputDto) {
    await this.tasks.sendInput(id, body.text);
    return { accepted: true };
  }

  /** List approval requests for a task. */
  @Get(':id/approvals')
  async listApprovals(@Param('id') id: string) {
    return this.tasks.listApprovals(id);
  }

  /** Request a diff summary for a task. Returns 202. */
  @Post(':id/diff-summary')
  @HttpCode(202)
  async summarizeDiff(@Param('id') id: string) {
    return this.tasks.summarizeDiff(id);
  }

  /** Run a configured test command for a task. Returns 202. */
  @Post(':id/test-runs')
  @HttpCode(202)
  async runTest(@Param('id') id: string, @Body() body: RunTestDto) {
    return this.tasks.runTest(id, body.commandId);
  }

  /** List configured test commands from the policy file. */
  @Get(':id/test-commands')
  async listTestCommands(@Param('id') id: string) {
    return this.tasks.listTestCommands(id);
  }

  /** Restore a dormant session back to running. Returns 202. */
  @Post(':id/restore')
  @HttpCode(202)
  async restoreTask(@Param('id') id: string) {
    return this.tasks.restoreTask(id);
  }

  /** Request an approval-gated commit for a task. Returns 202 when approved and committed. */
  @Post(':id/commit')
  @HttpCode(202)
  async commitTask(@Param('id') id: string, @Body() body: CommitTaskDto) {
    return this.tasks.commitTask(id, body);
  }

  /** Request an approval-gated push for a task. Returns 202 when approved and pushed. */
  @Post(':id/push')
  @HttpCode(202)
  async pushTask(@Param('id') id: string, @Body() body: PushTaskDto) {
    return this.tasks.pushTask(id, body);
  }
}

/** Parse an optional query param to a non-negative integer, returning undefined if absent or invalid. */
function parseCursor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
