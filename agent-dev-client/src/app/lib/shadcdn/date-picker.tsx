import * as React from 'react';
import { LucideIcon } from '@/app/lib/components/LucideIcon';
import { cn } from '@/app/lib/utils';
import { Button } from './button';
import { Calendar } from './calendar';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

type Props = {
  onChange: (date: string) => void;
};

export const DatePicker: React.FC<Props> = ({ onChange }) => {
  const [date, setDate] = React.useState<Date>();
  const intl = useIntl();

  const dateChanged = (d?: Date) => {
    setDate(d);
    onChange(d ? d.toDateString() : '');
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={'outline'}
          className={cn(
            'w-full shadow-none min-h-[48px] rounded-xl justify-start text-left font-normal',
            !date && 'text-muted-foreground',
          )}
        >
          <LucideIcon name="calendar" size={16} className="mr-2" />
          {date ? (
            intl.formatDate(date, { year: 'numeric', month: 'long', day: 'numeric' })
          ) : (
            <span>{intl.formatMessage(messages.pickDate)}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar mode="single" selected={date} onSelect={dateChanged} initialFocus />
      </PopoverContent>
    </Popover>
  );
};
