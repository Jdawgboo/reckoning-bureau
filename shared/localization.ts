export type LocalizationLocale = string;

export interface LocalizationBundle {
  locale: LocalizationLocale;
  messages: Record<string, string>;
}

export interface LocalizationBundleIdentity {
  catalogRevision: string;
  messageLocale: LocalizationLocale;
  sessionLocaleRevision: number;
}

export interface LocalizationOwnerOverlay {
  locale: LocalizationLocale;
  messages: Record<string, string>;
}

export interface LocalizationClientBuild {
  catalogRevision: string;
  sourceLocale: LocalizationLocale;
  bundles: LocalizationBundle[];
}

export interface LocalizationServerBuild extends LocalizationClientBuild {
  policyVersion: string;
  catalogJson: string;
  ownerOverlays: LocalizationOwnerOverlay[];
}

export interface LocalizationResolveRequest {
  catalogRevision: string;
  messageLocale: LocalizationLocale;
  policyVersion: string;
  catalogJson: string;
}

export interface LocalizationResolveReady {
  status: 'ready';
  catalogRevision: string;
  policyVersion: string;
  bundle: LocalizationBundle;
}

export type LocalizationFallbackReason =
  | 'busy'
  | 'rate-limited'
  | 'generation-failed'
  | 'storage-failed';

export interface LocalizationResolveSourceFallback {
  status: 'source-fallback';
  catalogRevision: string;
  messageLocale: LocalizationLocale;
  policyVersion: string;
  reason: LocalizationFallbackReason;
  retryAfterMs?: number;
}

export type LocalizationResolveResult =
  | LocalizationResolveReady
  | LocalizationResolveSourceFallback;
