/**
 * Builtin chart (bar / line / area / pie) on recharts, adapted from the
 * admin-client's ChartComponent. Colors follow the FIXED slot order of the
 * validated categorical palette (the shared `--chart-1..6` theme tokens, light
 * + dark selected separately) — series never pick their own colors. Marks per the dataviz specs: thin bars with
 * rounded data-ends, 2px lines, recessive grid, legend only for ≥2 series,
 * hover tooltips everywhere.
 */
import { useId, type FC } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Label,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from 'recharts';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { optStr, str } from '@/app/lib/a2ui/props.ts';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { BlockSkeleton } from '@/app/lib/a2ui/blocks/BlockSkeleton.tsx';

type ChartKind = 'bar' | 'line' | 'area' | 'pie';
type ChartRow = Record<string, string | number | null>;

export interface ChartProps {
  chartType: ChartKind;
  title?: string;
  description?: string;
  categories: string[];
  series: { label: string; values: number[] }[];
  stacked?: boolean;
}

const X_KEY = '__category';

/** Validated categorical palette — the concrete hex of the shared
 *  `--chart-1..6` theme tokens (light + dark selected separately). Hardcoded
 *  because recharts writes SVG presentation attributes, where `var()` is not
 *  reliable; keep in sync with the `--chart-*` values in the theme-color
 *  files. Fixed slot order = the CVD-safety mechanism. */
const PALETTE_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948'];
const PALETTE_DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767'];
const TOKENS_LIGHT = { grid: '#e8e5e0', tick: '#6e6a64', surface: '#ffffff', ink: '#1c1b1a' };
const TOKENS_DARK = { grid: '#232624', tick: '#9b9e9a', surface: '#141615', ink: '#f2f1ee' };

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

const COMPACT_NUMBER = new Intl.NumberFormat(undefined, { notation: 'compact' });

function compactTick(value: number): string {
  return COMPACT_NUMBER.format(value);
}

const ChartTooltipContent: FC<TooltipProps<number, string>> = ({ active, payload, label }) => {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  return (
    <div className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-lift">
      {label != null && label !== '' && (
        <div className="mb-1 font-medium text-foreground">{String(label)}</div>
      )}
      <div className="flex flex-col gap-0.5">
        {payload.map((entry) => (
          <div key={String(entry.name)} className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className="h-2 w-2 rounded-[2px]"
                style={{ background: entry.color ?? entry.payload?.fill }}
              />
              {String(entry.name)}
            </span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">
              {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

function toRows(categories: string[], series: ChartProps['series']): ChartRow[] {
  return categories.map((category, rowIndex) => {
    const row: ChartRow = { [X_KEY]: category };
    for (const entry of series) {
      row[entry.label] = entry.values[rowIndex] ?? null;
    }
    return row;
  });
}

const ChartCard: FC<ChartProps> = ({
  chartType,
  title,
  description,
  categories,
  series,
  stacked,
}) => {
  const gradientBaseId = useId();
  const dark = isDarkMode();
  const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;
  const tokens = dark ? TOKENS_DARK : TOKENS_LIGHT;

  if (categories.length === 0 || series.length === 0) {
    return <BlockSkeleton variant="cards" />;
  }

  const rows = toRows(categories, series);
  const tick = { fill: tokens.tick, fontSize: 11.5 };
  const axisProps = { tickLine: false, axisLine: false, tickMargin: 8 } as const;
  const lineCursor = { stroke: tokens.grid, strokeDasharray: '3 3' };
  const showLegend = series.length >= 2 || chartType === 'pie';
  const legend = showLegend ? (
    <Legend
      wrapperStyle={{ fontSize: 12, color: tokens.tick, paddingTop: 8 }}
      iconSize={8}
      iconType="circle"
    />
  ) : null;
  const gradientId = (index: number) => `${gradientBaseId}-s${index}`;
  const areaGradients = (
    <defs>
      {series.map((entry, index) => (
        <linearGradient key={entry.label} id={gradientId(index)} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette[index % palette.length]} stopOpacity={0.32} />
          <stop offset="100%" stopColor={palette[index % palette.length]} stopOpacity={0.02} />
        </linearGradient>
      ))}
    </defs>
  );

  let plot: JSX.Element;
  if (chartType === 'pie') {
    const slices = categories.map((category, index) => ({
      name: category,
      value: series[0]?.values[index] ?? 0,
    }));
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    plot = (
      <PieChart>
        <Tooltip content={<ChartTooltipContent />} />
        {legend}
        <Pie
          data={slices}
          dataKey="value"
          nameKey="name"
          innerRadius="58%"
          paddingAngle={2}
          cornerRadius={4}
          stroke={tokens.surface}
          strokeWidth={2}
        >
          {slices.map((slice, index) => (
            <Cell key={slice.name} fill={palette[index % palette.length]} />
          ))}
          <Label
            value={total.toLocaleString()}
            position="center"
            fill={tokens.ink}
            style={{ fontSize: 22, fontWeight: 700 }}
          />
        </Pie>
      </PieChart>
    );
  } else if (chartType === 'line') {
    plot = (
      <LineChart data={rows}>
        <CartesianGrid stroke={tokens.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={X_KEY} tick={tick} stroke={tokens.grid} {...axisProps} />
        <YAxis
          tick={tick}
          stroke={tokens.grid}
          width={40}
          tickFormatter={compactTick}
          {...axisProps}
        />
        <Tooltip content={<ChartTooltipContent />} cursor={lineCursor} />
        {legend}
        {series.map((entry, index) => (
          <Line
            key={entry.label}
            type="monotone"
            dataKey={entry.label}
            stroke={palette[index % palette.length]}
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4.5, strokeWidth: 2, stroke: tokens.surface }}
          />
        ))}
      </LineChart>
    );
  } else if (chartType === 'area') {
    plot = (
      <AreaChart data={rows}>
        {areaGradients}
        <CartesianGrid stroke={tokens.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={X_KEY} tick={tick} stroke={tokens.grid} {...axisProps} />
        <YAxis
          tick={tick}
          stroke={tokens.grid}
          width={40}
          tickFormatter={compactTick}
          {...axisProps}
        />
        <Tooltip content={<ChartTooltipContent />} cursor={lineCursor} />
        {legend}
        {series.map((entry, index) => (
          <Area
            key={entry.label}
            type="monotone"
            dataKey={entry.label}
            stackId={stacked ? 'stack' : undefined}
            stroke={palette[index % palette.length]}
            strokeWidth={2}
            fill={`url(#${gradientId(index)})`}
          />
        ))}
      </AreaChart>
    );
  } else {
    plot = (
      <BarChart data={rows} barCategoryGap="28%" barGap={3}>
        <CartesianGrid stroke={tokens.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={X_KEY} tick={tick} stroke={tokens.grid} {...axisProps} />
        <YAxis
          tick={tick}
          stroke={tokens.grid}
          width={40}
          tickFormatter={compactTick}
          {...axisProps}
        />
        <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'var(--stage-spot)' }} />
        {legend}
        {series.map((entry, index) => (
          <Bar
            key={entry.label}
            dataKey={entry.label}
            stackId={stacked ? 'stack' : undefined}
            fill={palette[index % palette.length]}
            radius={stacked ? 0 : [6, 6, 0, 0]}
            maxBarSize={28}
          />
        ))}
      </BarChart>
    );
  }

  return (
    <div className="w-full">
      {title && <h3 className="mb-1 text-base font-semibold text-foreground">{title}</h3>}
      {description && <p className="mb-3 text-sm text-muted-foreground">{description}</p>}
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {plot}
        </ResponsiveContainer>
      </div>
    </div>
  );
};

function chartKind(value: unknown): ChartKind {
  return value === 'line' || value === 'area' || value === 'pie' ? value : 'bar';
}

function toSeries(value: unknown): ChartProps['series'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry, index) => ({
    label: typeof entry.label === 'string' ? entry.label : `Series ${index + 1}`,
    values: Array.isArray(entry.values)
      ? entry.values.map((v: unknown) => (typeof v === 'number' ? v : 0))
      : [],
  }));
}

export const ChartSurface: FC<A2uiNodeViewProps> = ({ node }) => (
  <ChartCard
    chartType={chartKind(node.props.chartType)}
    title={optStr(node.props.title)}
    description={optStr(node.props.description)}
    categories={
      Array.isArray(node.props.categories) ? node.props.categories.map((c) => str(c)) : []
    }
    series={toSeries(node.props.series)}
    stacked={node.props.stacked === true}
  />
);

export default ChartCard;
