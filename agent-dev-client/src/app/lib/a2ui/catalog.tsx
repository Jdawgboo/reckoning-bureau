/**
 * React realization of the A2UI catalog. One component per trusted type;
 * unknown types render A2uiFallback. TextField and ChoicePicker are
 * controlled when bound via `{path}` (writes go through
 * `A2uiSurfaceApi.setValue`); Button is the only component that may trigger a
 * send, via `api.submit(node)`.
 */
import { useContext, type FC, type ReactNode } from 'react';
import type { ResolvedNode } from '../../../../vendor/agentplace-a2ui/walker.ts';
import { Button } from '../shadcdn/button';
import { Card, CardContent, CardHeader, CardTitle } from '../shadcdn/card';
import { Input } from '../shadcdn/input';
import { Label } from '../shadcdn/label';
import { RadioGroup, RadioGroupItem } from '../shadcdn/radio-group';
import { Separator } from '../shadcdn/separator';
import { A2uiSurfaceContext } from './surface-context.ts';
import { isRecord } from '../util/type-guards.ts';

export interface A2uiNodeViewProps {
  node: ResolvedNode;
  renderChildren: () => ReactNode;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const TextView: FC<A2uiNodeViewProps> = ({ node }) => {
  const text = str(node.props.text);
  const variant = str(node.props.variant);
  if (variant === 'h1') return <h1 className="text-2xl font-semibold">{text}</h1>;
  if (variant === 'h2') return <h2 className="text-xl font-semibold">{text}</h2>;
  if (variant === 'h3') return <h3 className="text-lg font-medium">{text}</h3>;
  return <p className="text-sm">{text}</p>;
};

const RowView: FC<A2uiNodeViewProps> = ({ renderChildren }) => (
  <div className="flex flex-row items-center gap-3">{renderChildren()}</div>
);

const ColumnView: FC<A2uiNodeViewProps> = ({ renderChildren }) => (
  <div className="flex w-full flex-col gap-8">{renderChildren()}</div>
);

const CardView: FC<A2uiNodeViewProps> = ({ node, renderChildren }) => {
  const title = str(node.props.title);
  return (
    <Card>
      {title ? (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className="flex flex-col gap-3">{renderChildren()}</CardContent>
    </Card>
  );
};

const NodeErrors: FC<{ messages: string[] }> = ({ messages }) => {
  if (messages.length === 0) {
    return null;
  }
  return (
    <>
      {messages.map((message) => (
        <p key={message} className="text-xs text-destructive">
          {message}
        </p>
      ))}
    </>
  );
};

const ButtonView: FC<A2uiNodeViewProps> = ({ node, renderChildren }) => {
  const api = useContext(A2uiSurfaceContext);
  const label = str(node.props.label);
  const hasAction = isRecord(node.props.action);
  return (
    <Button type="button" disabled={!hasAction || !api} onClick={() => api?.submit(node)}>
      {label || renderChildren()}
    </Button>
  );
};

const TextFieldView: FC<A2uiNodeViewProps> = ({ node }) => {
  const api = useContext(A2uiSurfaceContext);
  const label = str(node.props.label);
  const pointer = node.bindings.value;
  const errors = api?.errorsFor(node.id) ?? [];

  if (pointer && api) {
    const bound = str(api.getValue(pointer) ?? node.props.value);
    return (
      <div className="flex flex-col gap-1.5">
        {label ? <Label htmlFor={node.id}>{label}</Label> : null}
        <Input id={node.id} value={bound} onChange={(e) => api.setValue(pointer, e.target.value)} />
        <NodeErrors messages={errors} />
      </div>
    );
  }

  const value = node.props.value;
  const initial = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <Label htmlFor={node.id}>{label}</Label> : null}
      <Input id={node.id} defaultValue={initial} />
      <NodeErrors messages={errors} />
    </div>
  );
};

const ChoicePickerView: FC<A2uiNodeViewProps> = ({ node }) => {
  const api = useContext(A2uiSurfaceContext);
  const label = str(node.props.label);
  const options = Array.isArray(node.props.options) ? node.props.options : [];
  const pointer = node.bindings.value;
  const errors = api?.errorsFor(node.id) ?? [];
  const controlledValue = pointer && api ? str(api.getValue(pointer)) : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? <Label>{label}</Label> : null}
      <RadioGroup
        value={controlledValue}
        onValueChange={pointer && api ? (v) => api.setValue(pointer, v) : undefined}
      >
        {options.map((option, index) => {
          const optionLabel =
            typeof option === 'string' ? option : str((option as Record<string, unknown>)?.label);
          const optionValue =
            typeof option === 'string'
              ? option
              : str((option as Record<string, unknown>)?.value) || optionLabel;
          const itemId = `${node.id}-${index}`;
          return (
            <div key={itemId} className="flex items-center gap-2">
              <RadioGroupItem value={optionValue} id={itemId} />
              <Label htmlFor={itemId}>{optionLabel}</Label>
            </div>
          );
        })}
      </RadioGroup>
      <NodeErrors messages={errors} />
    </div>
  );
};

const ImageView: FC<A2uiNodeViewProps> = ({ node }) => {
  const src = str(node.props.src ?? node.props.url);
  const alt = str(node.props.alt);
  if (!src) return null;
  return <img src={src} alt={alt} className="max-w-full rounded-md" />;
};

const DividerView: FC<A2uiNodeViewProps> = () => <Separator />;

const ListView: FC<A2uiNodeViewProps> = ({ node, renderChildren }) => {
  const items = Array.isArray(node.props.items) ? node.props.items : [];
  if (items.length > 0) {
    return (
      <ul className="list-disc pl-5 text-sm flex flex-col gap-1">
        {items.map((item, index) => {
          const text =
            typeof item === 'string' ? item : str((item as Record<string, unknown>)?.label);
          // biome-ignore lint/suspicious/noArrayIndexKey: items carry no ids
          return <li key={index}>{text}</li>;
        })}
      </ul>
    );
  }
  return <ul className="list-disc pl-5 text-sm flex flex-col gap-1">{renderChildren()}</ul>;
};

export const A2uiFallback: FC<A2uiNodeViewProps> = ({ node }) => (
  <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
    Unsupported component: {node.component}
  </div>
);

export const A2UI_REACT_CATALOG: Record<string, FC<A2uiNodeViewProps>> = {
  Text: TextView,
  Row: RowView,
  Column: ColumnView,
  Card: CardView,
  Button: ButtonView,
  TextField: TextFieldView,
  ChoicePicker: ChoicePickerView,
  Image: ImageView,
  Divider: DividerView,
  List: ListView,
};
