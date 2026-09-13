import { useEffect, useMemo, useState, type FC, type FormEvent } from 'react';
import { Gavel, Send, Square } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { num, str } from '@/app/lib/a2ui/props.ts';
import { useSurfaceAction } from '@/app/lib/a2ui/surface-context.ts';

const messages = defineMessages({
  overline: { id: 'oppositionHearing.overline', defaultMessage: 'Respondent counsel' },
  title: { id: 'oppositionHearing.title', defaultMessage: 'Face the Opposition' },
  exchange: { id: 'oppositionHearing.exchange', defaultMessage: 'Exchange {current} of 10' },
  record: {
    id: 'oppositionHearing.record',
    defaultMessage: 'Counsel may use only the chronology and exhibits recorded for this hearing.',
  },
  answer: { id: 'oppositionHearing.answer', defaultMessage: 'Your answer' },
  placeholder: {
    id: 'oppositionHearing.placeholder',
    defaultMessage: 'State only what the record can support.',
  },
  submit: { id: 'oppositionHearing.submit', defaultMessage: 'Put the answer to counsel' },
  end: { id: 'oppositionHearing.end', defaultMessage: 'End the hearing' },
  stopped: { id: 'oppositionHearing.stopped', defaultMessage: 'Hearing stopped' },
  review: { id: 'oppositionHearing.review', defaultMessage: 'Review note' },
  stoppedNote: {
    id: 'oppositionHearing.stoppedNote',
    defaultMessage: 'The hearing stopped at your instruction. No assessment has been made.',
  },
});

export const OppositionHearing: FC<A2uiNodeViewProps> = ({ node }) => {
  const intl = useIntl();
  const dispatch = useSurfaceAction();
  const docket = str(node.props.docket);
  const hearingPacket = str(node.props.hearingPacket);
  const exchange = Math.max(0, Math.min(10, num(node.props.exchange) ?? 0));
  const question = str(node.props.question);
  const transcript = str(node.props.transcript);
  const state = str(node.props.state) || 'questioning';
  const note = str(node.props.note);
  const [answer, setAnswer] = useState('');

  useEffect(() => {
    setAnswer('');
  }, [question, state]);

  const currentExchange = useMemo(() => Math.min(exchange + 1, 10), [exchange]);

  const dispatchResponse = (nextAnswer: string, endRequested: boolean, stopRequested: boolean) => {
    dispatch?.('hearingAnswer', {
      docket,
      hearingPacket,
      exchange,
      question,
      transcript,
      answer: nextAnswer,
      endRequested,
      stopRequested,
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = answer.trim();
    if (!trimmed) return;
    const stopRequested = /\bstop\b/i.test(trimmed);
    const endRequested = !stopRequested && (exchange >= 9 || /\bend the hearing\b/i.test(trimmed));
    dispatchResponse(trimmed, endRequested, stopRequested);
  };

  const end = () => dispatchResponse('', true, false);
  const isQuestioning = state === 'questioning';
  const displayNote = state === 'stopped' ? intl.formatMessage(messages.stoppedNote) : note;

  return (
    <section className="w-full border border-border bg-card p-6 shadow-elevated sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <div className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground">
            {intl.formatMessage(messages.overline)}
          </div>
          <h1 className="mt-1 font-display text-heading-xl font-semibold tracking-tight text-foreground">
            {intl.formatMessage(messages.title)}
          </h1>
        </div>
        {isQuestioning ? (
          <span className="border border-primary/50 px-2 py-1 font-mono text-body-xs uppercase tracking-caps text-primary">
            {intl.formatMessage(messages.exchange, { current: currentExchange })}
          </span>
        ) : null}
      </div>

      {isQuestioning ? (
        <>
          <div className="mt-5 flex gap-3 border-l-2 border-primary pl-4">
            <Gavel className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
            <p className="max-w-[66ch] font-display text-heading-sm font-semibold leading-relaxed text-foreground">
              {question}
            </p>
          </div>
          <p className="mt-5 max-w-[66ch] font-mono text-body-xs leading-relaxed text-muted-foreground">
            {intl.formatMessage(messages.record)}
          </p>
          <form className="mt-6" onSubmit={submit}>
            <label className="block font-mono text-body-xs uppercase tracking-caps text-foreground" htmlFor={`hearing-answer-${docket}`}>
              {intl.formatMessage(messages.answer)}
            </label>
            <textarea
              id={`hearing-answer-${docket}`}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              rows={5}
              className="mt-2 block w-full resize-y border border-border bg-background px-3 py-3 text-body-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
              placeholder={intl.formatMessage(messages.placeholder)}
            />
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={end}
                className="font-mono text-body-xs uppercase tracking-caps text-muted-foreground underline decoration-border underline-offset-4 transition hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary"
              >
                {intl.formatMessage(messages.end)}
              </button>
              <button
                type="submit"
                disabled={!answer.trim()}
                className="inline-flex items-center justify-center gap-2 border-2 border-primary px-4 py-2.5 font-mono text-body-xs uppercase tracking-caps text-primary transition duration-150 hover:bg-primary hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-primary active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                {intl.formatMessage(messages.submit)}
              </button>
            </div>
          </form>
        </>
      ) : (
        <div className="mt-6">
          <div className="flex items-center gap-2 font-mono text-body-xs uppercase tracking-caps text-primary">
            <Square className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {intl.formatMessage(state === 'stopped' ? messages.stopped : messages.review)}
          </div>
          <p className="mt-3 max-w-[70ch] whitespace-pre-line font-display text-body-base leading-relaxed text-foreground">
            {displayNote}
          </p>
        </div>
      )}
    </section>
  );
};
