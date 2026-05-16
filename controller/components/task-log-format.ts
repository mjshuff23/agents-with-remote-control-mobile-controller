export interface AgentMessageFormat {
  label: 'Agent:';
  labelClassName: string;
  text: string;
}

export function formatAgentMessage(item: { type: string; text?: string }): AgentMessageFormat | null {
  if (item.type !== 'agent_message' || !item.text) {
    return null;
  }

  return {
    label: 'Agent:',
    labelClassName: 'text-orange-300 font-semibold',
    text: item.text
  };
}
