import React, { useMemo } from 'react';
import {
  AreaChart, Area, Tooltip, ResponsiveContainer,
} from 'recharts';
import { metricColor } from '../utils';

interface HistoryChartProps {
  values: number[];
  timestamps?: string[];
  /** Explicit hex color; falls back to metricColor(latestPct) */
  color?: string;
  /** If no explicit color, derive from this percentage */
  latestPct?: number;
  height?: number;
  formatTooltip?: (v: number) => string;
}

interface Pt { v: number; t?: string; }

export function HistoryChart({
  values,
  timestamps,
  color,
  latestPct,
  height = 56,
  formatTooltip,
}: HistoryChartProps) {
  const c = color ?? (latestPct !== undefined ? metricColor(latestPct) : '#06b6d4');

  const data: Pt[] = useMemo(
    () => values.map((v, i) => ({ v: typeof v === 'number' ? v : Number(v) || 0, t: timestamps?.[i] })),
    [values, timestamps],
  );

  if (values.length < 2) {
    return (
      <div
        className="w-full rounded-md bg-gray-800/40 animate-pulse"
        style={{ height }}
      />
    );
  }

  // Stable gradient id derived from color (no random)
  const gradId = `hg${c.replace('#', '')}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={c} stopOpacity={0.28} />
            <stop offset="100%" stopColor={c} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null;
            const val = payload[0].value as number;
            const label = formatTooltip ? formatTooltip(val) : `${val.toFixed(1)}%`;
            return (
              <div className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200 shadow-lg">
                {label}
              </div>
            );
          }}
          cursor={{ stroke: c, strokeWidth: 1, strokeDasharray: '3 3', strokeOpacity: 0.5 }}
        />
        <Area
          type="monotone"
          dataKey="v"
          stroke={c}
          strokeWidth={1.5}
          fill={`url(#${gradId})`}
          dot={false}
          activeDot={{ r: 3, fill: c, stroke: 'none' }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
