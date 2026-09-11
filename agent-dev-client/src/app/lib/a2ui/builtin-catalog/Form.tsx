/**
 * `Form` — generic typed-detail collector (contact info, preferences,
 * requirements). Thin binding: `fields[]` → the shared `SmartFormFields`
 * block. Local state mirrors each field's value (seeded from `value`);
 * every keystroke both updates local state and calls
 * `setValue('/form/{id}', value)` so the agent sees the latest values in
 * `<ui_state>` on its next turn. `errors` arrives agent-computed — the
 * component only displays it, never validates. The submit CTA dispatches
 * `submitForm` with an empty context; the agent reads the whole `/form`
 * namespace itself.
 */
import { useContext, useState, type FC } from 'react';
import { A2uiSurfaceContext } from '@/app/lib/a2ui/surface-context.ts';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { SurfaceHeader } from '@/app/lib/a2ui/blocks/SurfaceHeader.tsx';
import { SmartFormFields, type SmartField } from '@/app/lib/a2ui/blocks/SmartFormFields.tsx';
import { Button } from '@/app/lib/shadcdn/button';
import { BlockSkeleton } from '@/app/lib/a2ui/blocks/BlockSkeleton.tsx';
import { arr, optStr, str } from '@/app/lib/a2ui/props.ts';
import { useIntl } from 'react-intl';
import { messages } from '@/app/lib/localization/messages.ts';

const FIELD_KINDS: ReadonlySet<string> = new Set(['text', 'email', 'phone', 'choice', 'note']);

function isFieldKind(value: string): value is SmartField['kind'] {
  return FIELD_KINDS.has(value);
}

interface FormField {
  id: string;
  label: string;
  kind: SmartField['kind'];
  options?: SmartField['options'];
  value?: string;
  prefilled?: boolean;
  errors?: string[];
}

function readOptions(raw: unknown): SmartField['options'] {
  const values = arr(raw).filter((option): option is string => typeof option === 'string');
  return values.length > 0 ? values.map((value) => ({ value, label: value })) : undefined;
}

function readErrors(raw: unknown): string[] | undefined {
  const values = arr(raw).filter((error): error is string => typeof error === 'string');
  return values.length > 0 ? values : undefined;
}

function readField(raw: unknown): FormField | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = str(raw.id);
  const label = str(raw.label);
  const kind = str(raw.kind);
  if (!id || !label || !isFieldKind(kind)) {
    return null;
  }
  return {
    id,
    label,
    kind,
    options: readOptions(raw.options),
    value: optStr(raw.value),
    prefilled: raw.prefilled === true,
    errors: readErrors(raw.errors),
  };
}

function fieldPointer(fieldId: string): string {
  return `/form/${fieldId}`;
}

function seedValues(fields: FormField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.value !== undefined) {
      values[field.id] = field.value;
    }
  }
  return values;
}

function columnsFor(node: A2uiNodeViewProps['node']): 1 | 2 {
  return str(node.props.columns) === '1' ? 1 : 2;
}

export const FormSurface: FC<A2uiNodeViewProps> = ({ node }) => {
  const api = useContext(A2uiSurfaceContext);
  const intl = useIntl();
  const fields = arr(node.props.fields)
    .map(readField)
    .filter((field): field is FormField => field !== null);
  const [values, setValues] = useState<Record<string, string>>(() => seedValues(fields));

  if (!Array.isArray(node.props.fields) || fields.length === 0) {
    return <BlockSkeleton variant="form" />;
  }

  const handleChange = (id: string, value: string) => {
    setValues((prev) => ({ ...prev, [id]: value }));
    api?.setValue(fieldPointer(id), value);
  };

  const handleSubmit = () => {
    api?.dispatch('submitForm', {});
  };

  const smartFields: SmartField[] = fields.map((field) => ({
    id: field.id,
    label: field.label,
    kind: field.kind,
    options: field.options,
    value: values[field.id] ?? field.value ?? '',
    prefilled: field.prefilled,
    errors: field.errors,
  }));

  const title = str(node.props.title);
  const subtitle = optStr(node.props.subtitle);

  return (
    <div className="w-full max-w-container-form">
      {title ? <SurfaceHeader title={title} subtitle={subtitle} /> : null}
      <SmartFormFields
        fields={smartFields}
        onChange={handleChange}
        onCommit={() => api?.commitValue()}
        columns={columnsFor(node)}
        selectPlaceholder={intl.formatMessage(messages.selectPlaceholder)}
        prefilledLabel={intl.formatMessage(messages.prefilled)}
      />
      <div className="mt-5 flex justify-end">
        <Button type="button" className="h-10 rounded-lg px-6" onClick={handleSubmit}>
          {str(node.props.submitLabel) || intl.formatMessage(messages.submit)}
        </Button>
      </div>
    </div>
  );
};
