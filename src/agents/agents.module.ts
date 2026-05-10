import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { AGENT_ADAPTERS } from './agent-adapter.token';
import { AgentsService } from './agents.service';
import { CodexAdapter } from './codex.adapter';

@Module({
  imports: [AppConfigModule],
  providers: [
    CodexAdapter,
    {
      provide: AGENT_ADAPTERS,
      useFactory: (codexAdapter: CodexAdapter) => [codexAdapter],
      inject: [CodexAdapter]
    },
    AgentsService
  ],
  exports: [AgentsService, AGENT_ADAPTERS]
})
export class AgentsModule {}
