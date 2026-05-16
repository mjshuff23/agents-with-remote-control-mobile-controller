import { formatAgentMessage } from '../controller/components/task-log-format';

describe('task log formatting', () => {
  it('labels Codex agent messages with an orange Agent prefix', () => {
    expect(formatAgentMessage({ type: 'agent_message', text: 'Saturday, May 16, 2026.' })).toEqual({
      label: 'Agent:',
      labelClassName: 'text-orange-300 font-semibold',
      text: 'Saturday, May 16, 2026.'
    });
  });

  it('does not label non-agent items', () => {
    expect(formatAgentMessage({ type: 'tool_call', text: 'ignored' })).toBeNull();
  });
});
