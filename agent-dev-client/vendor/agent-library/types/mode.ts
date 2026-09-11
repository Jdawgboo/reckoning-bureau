export const AgentMode = {
  Agent: 'agent',
  Website: 'website',
  Components: 'components',
} as const;
export type AgentMode = (typeof AgentMode)[keyof typeof AgentMode];
