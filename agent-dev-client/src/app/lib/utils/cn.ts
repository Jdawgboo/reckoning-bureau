import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** Out of the box tailwind-merge only dedupes the built-in animation names
 *  (`animate-spin` …), so two custom `animate-*` classes would both survive
 *  and the stylesheet order — not the class list — would pick the winner.
 *  Treat every `animate-*` as one group, matching Tailwind's semantics (they
 *  all compile to the `animation` shorthand). */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { animate: [{ animate: [() => true] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
