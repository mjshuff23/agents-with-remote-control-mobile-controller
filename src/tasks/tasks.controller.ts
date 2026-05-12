import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ControllerSecretGuard } from '../common/guards/controller-secret.guard';
import { RunTestDto } from '../test-runs/dto/run-test.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { SendInputDto } from './dto/send-input.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
@UseGuards(ControllerSecretGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  async createTask(@Body() body: CreateTaskDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.tasks.createTask(body);
    response.location(`/tasks/${result.task.id}`);
    return result;
  }

  @Get()
  async listTasks() {
    return this.tasks.listTasks();
  }

  @Get(':id')
  async getTask(@Param('id') id: string) {
    return this.tasks.getTask(id);
  }

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

  @Post(':id/stop')
  async stopTask(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.tasks.stopTask(id);
    response.status(result.accepted ? 202 : 200);
    return result;
  }

  @Post(':id/input')
  @HttpCode(202)
  async sendInput(@Param('id') id: string, @Body() body: SendInputDto) {
    await this.tasks.sendInput(id, body.text);
    return { accepted: true };
  }

  @Get(':id/approvals')
  async listApprovals(@Param('id') id: string) {
    return this.tasks.listApprovals(id);
  }

  @Post(':id/diff-summary')
  @HttpCode(202)
  async summarizeDiff(@Param('id') id: string) {
    return this.tasks.summarizeDiff(id);
  }

  @Post(':id/test-runs')
  @HttpCode(202)
  async runTest(@Param('id') id: string, @Body() body: RunTestDto) {
    return this.tasks.runTest(id, body.commandId);
  }

  @Get(':id/test-commands')
  async listTestCommands(@Param('id') id: string) {
    return this.tasks.listTestCommands(id);
  }
}

function parseCursor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
