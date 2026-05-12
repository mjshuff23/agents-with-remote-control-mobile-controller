import { Inject, Injectable } from '@nestjs/common';
import { ProblemException } from '../common/errors/problem.exception';
import { AgentAdapter } from './agent-adapter.interface';
import { AGENT_ADAPTERS } from './agent-adapter.token';

/** Registry that resolves an AgentAdapter by name from the multi-adapter injection token. */
@Injectable()
export class AgentsService {
  constructor(@Inject(AGENT_ADAPTERS) private readonly adapters: AgentAdapter[]) {}

  /**
   * Return the adapter registered for the given agent name.
   * @param name - Agent name to look up (e.g. "codex").
   * @returns The matching AgentAdapter.
   * @throws ProblemException(400) if no adapter is registered for the name.
   */
  getAdapter(name: string): AgentAdapter {
    const adapter = this.adapters.find((candidate) => candidate.name === name);
    if (!adapter) {
      throw new ProblemException(400, 'Unsupported Agent', `Agent "${name}" is not available in Phase 1.`);
    }
    return adapter;
  }
}
