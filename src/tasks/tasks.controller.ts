import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { CreateTaskDto } from './dto/create-task.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
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

  @Post(':id/stop')
  async stopTask(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.tasks.stopTask(id);
    response.status(result.accepted ? 202 : 200);
    return result;
  }
}
