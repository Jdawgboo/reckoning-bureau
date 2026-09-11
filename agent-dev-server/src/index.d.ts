declare module '*.md' {
  const content: string;
  export default content;
}

declare module 'virtual:agentplace-localization/server' {
  import type { LocalizationServerBuild } from '../../shared/localization.ts';

  export const LOCALIZATION_BUILD: LocalizationServerBuild;
}
