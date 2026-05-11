import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { EventsModule } from '../events/events.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GitCommandService } from './git-command.service';
import { GitDiffService } from './git-diff.service';
import { GitWorktreeService } from './git-worktree.service';

@Module({
  imports: [AppConfigModule, EventsModule, PrismaModule],
  providers: [GitCommandService, GitWorktreeService, GitDiffService],
  exports: [GitCommandService, GitWorktreeService, GitDiffService]
})
export class GitModule {}
