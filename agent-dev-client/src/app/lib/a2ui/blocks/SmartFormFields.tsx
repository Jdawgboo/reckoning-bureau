/**
 * Generic field list with prefill tags + inline errors, composed from the
 * shadcdn form primitives (Input/Textarea/Label/Select — Radix select for
 * keyboard/mobile a11y). `kind` picks the control (text/email/phone/choice/
 * note) and its `inputMode`; the "· pre-filled" tag copy is a
 * prop-independent generic label, not domain copy.
 */
import type { FC, ReactNode } from 'react';
import { cn } from '@/app/lib/utils';
import { Input } from '@/app/lib/shadcdn/input';
import { Textarea } from '@/app/lib/shadcdn/textarea';
import { Label } from '@/app/lib/shadcdn/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/lib/shadcdn/select';

export interface SmartFieldOption {
  value: string;
  label: string;
}

export interface SmartField {
  id: string;
  label: string;
  kind: 'text' | 'email' | 'phone' | 'choice' | 'note';
  options?: SmartFieldOption[];
  value?: string;
  /** Shows the "· pre-filled" tag. */
  prefilled?: boolean;
  errors?: string[];
}

export interface SmartFormFieldsProps {
  fields: SmartField[];
  onChange: (id: string, value: string) => void;
  /** Fired when a field loses focus — the agent gets what was typed without
   *  anything being submitted. Blur rather than keystroke: `<ui_state>` is
   *  re-read on every model call, so per-character syncing is pure waste. */
  onCommit?: () => void;
  /** 2-col layout ≥900px; always 1 below. */
  columns?: 1 | 2;
  selectPlaceholder: string;
  prefilledLabel: string;
}

const CONTROL_CLASS_NAME =
  'h-10 rounded-lg border-border bg-card px-3 text-sm text-foreground shadow-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/15';

/** `kind` → `inputmode`, for kind-appropriate mobile keyboards. */
function inputModeFor(kind: SmartField['kind']): 'tel' | 'email' | 'text' {
  if (kind === 'phone') {
    return 'tel';
  }
  if (kind === 'email') {
    return 'email';
  }
  return 'text';
}

function renderControl(
  field: SmartField,
  onChange: (id: string, value: string) => void,
  onCommit?: () => void,
  selectPlaceholder?: string,
): ReactNode {
  if (field.kind === 'choice') {
    const options = field.options ?? [];
    return (
      <Select
        value={field.value || undefined}
        onValueChange={(value) => {
          onChange(field.id, value);
          onCommit?.();
        }}
      >
        <SelectTrigger id={field.id} className={`${CONTROL_CLASS_NAME} [&>span]:text-foreground`}>
          <SelectValue placeholder={selectPlaceholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.kind === 'note') {
    return (
      <Textarea
        id={field.id}
        rows={3}
        value={field.value ?? ''}
        onChange={(event) => onChange(field.id, event.target.value)}
        onBlur={() => onCommit?.()}
        className={cn(CONTROL_CLASS_NAME, 'h-auto py-2')}
      />
    );
  }
  const inputType = field.kind === 'phone' ? 'tel' : field.kind;
  const inputMode = inputModeFor(field.kind);
  return (
    <Input
      id={field.id}
      type={inputType}
      inputMode={inputMode}
      value={field.value ?? ''}
      onChange={(event) => onChange(field.id, event.target.value)}
      onBlur={() => onCommit?.()}
      className={CONTROL_CLASS_NAME}
    />
  );
}

export const SmartFormFields: FC<SmartFormFieldsProps> = ({
  fields,
  onChange,
  onCommit,
  columns = 2,
  selectPlaceholder,
  prefilledLabel,
}) => (
  <div
    className="grid grid-cols-1 gap-x-4 gap-y-3.5 max-w-[720px] md:grid-cols-2 data-[columns=1]:md:grid-cols-1"
    data-columns={String(columns)}
  >
    {fields.map((field, index) => {
      const isWide = field.kind === 'note';
      const errors = field.errors ?? [];
      return (
        <div
          key={field.id}
          className="group animate-fadeUp data-[wide=true]:col-span-full"
          data-wide={isWide}
          data-prefilled={field.prefilled === true}
          style={{ animationDelay: `${index * 70}ms` }}
        >
          <Label
            htmlFor={field.id}
            className="mb-1.5 block text-sm font-medium leading-normal text-foreground"
          >
            {field.label}
            {field.prefilled ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground-subtle">
                {prefilledLabel}
              </span>
            ) : null}
          </Label>
          {renderControl(field, onChange, onCommit, selectPlaceholder)}
          {errors.map((error, errorIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: error messages carry no stable id
            <div key={errorIndex} className="mx-0.5 mt-1 text-xs text-warning">
              {error}
            </div>
          ))}
        </div>
      );
    })}
  </div>
);
