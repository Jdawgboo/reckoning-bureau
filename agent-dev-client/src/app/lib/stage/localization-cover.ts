import type { LocalizationTransition } from '../localization/localization-store.ts';

export interface LocalizationCoverTarget {
  messageLocale: string;
  formatLocale: string;
}

export interface LocalizationCoverResolution {
  visibleTarget: LocalizationCoverTarget | null;
  heldTarget: LocalizationCoverTarget | null;
}

export function resolveLocalizationCover(params: {
  transition: LocalizationTransition;
  activeTarget: LocalizationCoverTarget;
  heldTarget: LocalizationCoverTarget | null;
  localeActivationChanged: boolean;
  runActive: boolean;
}): LocalizationCoverResolution {
  let heldTarget = params.heldTarget;
  if (!params.runActive) {
    heldTarget = null;
  } else if (params.localeActivationChanged) {
    heldTarget = params.activeTarget;
  }
  if (params.transition.status === 'pending') {
    return {
      visibleTarget: {
        messageLocale: params.transition.messageLocale,
        formatLocale: params.transition.formatLocale,
      },
      heldTarget,
    };
  }
  return { visibleTarget: heldTarget, heldTarget };
}

export function sameLocalizationCoverTarget(
  left: LocalizationCoverTarget | null,
  right: LocalizationCoverTarget | null,
): boolean {
  return left?.messageLocale === right?.messageLocale && left?.formatLocale === right?.formatLocale;
}
