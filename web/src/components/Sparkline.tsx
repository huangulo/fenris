import React from 'react';

interface SparklineProps {
  values: number[];
  color: string;
  width?: number;
  height?: number;
  filled?: boolean;
}

export function Sparkline({ values, color, width = 72, height = 28, filled = true }: SparklineProps) {
  if (values.length < 2) {
    return (
      <div
        className="rounded animate-pulse bg-gray-800/50"
        style={{ width, height }}
      />
    );
  }

  const max   = Math.max(...values, 0.001);
  const min   = Math.min(...values);
  const range = max - min || 0.001;

  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * (width - 4) + 2,
    y: height - 2 - ((v - min) / range) * (height - 6),
  }));

  const poly = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const fill = filled
    ? [
        `2,${height}`,
        ...pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
        `${(width - 2).toFixed(1)},${height}`,
      ].join(' ')
    : '';

  return (
    <svg width={width} height={height} className="overflow-visible flex-shrink-0">
      {filled && (
        <polygon points={fill} fill={color} opacity={0.12} />
      )}
      <polyline
        points={poly}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
