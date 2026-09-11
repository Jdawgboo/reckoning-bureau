/**
 * Word-stagger text reveal (24ms/word), with selected words wrapped in an
 * accent `<strong>`. `prefers-reduced-motion` renders instantly via the
 * `motion-reduce:` variants.
 * Use-case-agnostic: `text`/`emphasis` are plain strings, no domain meaning.
 */
import type { FC } from 'react';

export interface StreamedTextProps {
  text: string;
  emphasis?: string[];
}

const PUNCTUATION_RE = /[.,!?;:]/g;

function bareWord(word: string): string {
  return word.replace(PUNCTUATION_RE, '').toLowerCase();
}

export const StreamedText: FC<StreamedTextProps> = ({ text, emphasis = [] }) => {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const emphasisSet = new Set(emphasis.map((word) => word.toLowerCase()));

  return (
    <div className="mx-auto max-w-prose text-lg leading-loose">
      {words.map((word, index) => {
        const style = { animationDelay: `${index * 24}ms` };
        const isEmphasis = emphasisSet.has(bareWord(word));
        const content = index < words.length - 1 ? `${word} ` : word;
        // Position key: words carry no stable id and the list never reorders.
        const key = `${index}-${word}`;
        if (isEmphasis) {
          return (
            <strong
              key={key}
              className="animate-word-in font-semibold text-primary opacity-0 motion-reduce:animate-none motion-reduce:opacity-100"
              style={style}
            >
              {content}
            </strong>
          );
        }
        return (
          <span
            key={key}
            className="animate-word-in opacity-0 motion-reduce:animate-none motion-reduce:opacity-100"
            style={style}
          >
            {content}
          </span>
        );
      })}
    </div>
  );
};
