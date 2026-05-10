import { Inject, Injectable } from '@nestjs/common';
import { ProblemException } from '../common/errors/problem.exception';
import { AgentAdapter, SupportedAgentName } from './agent-adapter.interface';
import { AGENT_ADAPTERS } from './agent-adapter.token';

@Injectable()
export class AgentsService {
  constructor(@Inject(AGENT_ADAPTERS) private readonly adapters: AgentAdapter[]) {}

  getAdapter(name: SupportedAgentName): AgentAdapter {
    const adapter = this.adapters.find((candidate) => candidate.name === name);
    if (!adapter) {
      throw new ProblemException(400, 'Unsupported Agent', `Agent "${name}" is not available in Phase 1.`);
    }
    return adapter;
  }
}
