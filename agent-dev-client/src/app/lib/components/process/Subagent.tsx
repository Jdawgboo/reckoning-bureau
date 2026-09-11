import { useState, type FC, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import type { AsArgumentsProps } from '@/app/lib/types';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/app/lib/shadcdn/collapsible';
import { cn } from '@/app/lib/utils';
import { useMessagingStore } from '@/app/lib/hooks/useMessagingStore';
import { LazyMarkdown as Markdown } from '@/app/lib/components/LazyMarkdown';
import { useIntl, type IntlShape } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

type SubagentArgumentsProps = {
  status?: 'running' | 'completed' | 'error';
  subagentType?: string;
  task?: string;
  toolCount?: number;
  lastToolName?: string;
  error?: string;
};

function getLabel(subagentType: string | undefined, fallback: string): string {
  if (subagentType && subagentType !== 'general-purpose') {
    return subagentType;
  }
  return fallback;
}

function formatToolCount(count: number, intl: IntlShape): string {
  return intl.formatMessage(messages.toolCalls, { count });
}

const CollapsibleBlock: FC<{
  title: ReactNode;
  children?: ReactNode;
}> = ({ title, children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const hasContent = children !== undefined && children !== null && children !== false;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full py-0">
      <CollapsibleTrigger
        disabled={!hasContent}
        className={cn(
          'group flex items-center gap-2 w-full py-1 rounded-sm outline-none',
          'focus-visible:outline-none focus-visible:ring-0',
          hasContent && 'cursor-pointer hover:bg-accent/5 transition-colors',
          !hasContent && 'cursor-default',
        )}
      >
        <span className="text-sm text-foreground/80 truncate">{title}</span>
        {hasContent && (
          <ChevronDown
            className={cn(
              'w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200',
              !isOpen && '-rotate-90',
            )}
          />
        )}
      </CollapsibleTrigger>
      {hasContent && (
        <CollapsibleContent className="overflow-x-auto overflow-y-visible">
          <div className="text-sm text-foreground/80 pt-2">{children}</div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

const RunningState: FC<{ props: SubagentArgumentsProps; text: string }> = ({ props, text }) => {
  const intl = useIntl();
  const { toolCount = 0, lastToolName } = props;
  const label = getLabel(props.subagentType, intl.formatMessage(messages.subagent));
  const countText = toolCount > 0 ? ` · ${formatToolCount(toolCount, intl)}` : '';

  const title = `${label}${countText}${lastToolName ? ` · ${lastToolName}` : ''}`;

  return (
    <CollapsibleBlock title={title}>
      {text ? (
        <div className="max-h-[320px] overflow-y-auto overflow-x-hidden px-1 scrollbar scrollbar-thin">
          <Markdown text={text} className="subagent" />
        </div>
      ) : null}
    </CollapsibleBlock>
  );
};

const CompletedState: FC<{ props: SubagentArgumentsProps; text: string }> = ({ props, text }) => {
  const intl = useIntl();
  const { toolCount = 0 } = props;
  const label = getLabel(props.subagentType, intl.formatMessage(messages.subagent));
  const title = `${label} · ${formatToolCount(toolCount, intl)}`;

  return (
    <CollapsibleBlock title={title}>
      {text ? (
        <div className="max-h-[320px] overflow-y-auto overflow-x-hidden px-1 scrollbar scrollbar-thin">
          <Markdown text={text} className="subagent" />
        </div>
      ) : null}
    </CollapsibleBlock>
  );
};

const ErrorState: FC<{ props: SubagentArgumentsProps }> = ({ props }) => {
  const intl = useIntl();
  const label = getLabel(props.subagentType, intl.formatMessage(messages.subagent));
  return (
    <div className="flex items-center gap-2 py-2">
      <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
      <span className="text-sm text-destructive">
        {props.error
          ? intl.formatMessage(messages.subagentFailedWithReason, {
              label,
              reason: props.error,
            })
          : intl.formatMessage(messages.subagentFailed, { label })}
      </span>
    </div>
  );
};

const SubagentComponent: FC<AsArgumentsProps<SubagentArgumentsProps>> = observer(
  ({ argumentsProps, toolPart }) => {
    const { status } = argumentsProps;
    const toolCallId = toolPart?.streaming?.toolCallId;
    const messagesStore = useMessagingStore();

    if (status === 'error') {
      return <ErrorState props={argumentsProps} />;
    }

    if (status === 'completed') {
      const fullText = messagesStore.getSubagentAssistantText(toolCallId ?? '');
      return <CompletedState props={argumentsProps} text={fullText} />;
    }

    const latestText = messagesStore.getSubagentLatestText(toolCallId ?? '');
    return <RunningState props={argumentsProps} text={latestText} />;
  },
);

export default SubagentComponent;
