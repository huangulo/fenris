import React from 'react';
import { metricColor } from '../utils';

interface CircularGaugeProps {
  /** 0–100 */
  value: number;
  /** Override the auto color derived from value */
  color?: string;
  /** Gauge diameter in px (default 108) */
  size?: number;
  strokeWidth?: number;
  /** Large text shown in the center */
  display: string;
  /** Optional smaller sub-text below display */
  sub?: string;
}

export function CircularGauge({
  value,
  color,
  size = 108,
  strokeWidth = 9,
  display,
  sub,
}: CircularGaugeProps) {
  const c = color ?? metricColor(value);
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const clampedPct = Math.max(0, Math.min(100, value));
  const offset = circumference - (clampedPct / 100) * circumference;
  const cx = size / 2;
  const cy = size / 2;

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      {/* SVG ring — rotated so arc starts at 12 o'clock */}
      <svg
        width={size}
        height={size}
        style={{ transform: 'rotate(-90deg)' }}
        className="absolute inset-0"
      >
        {/* Track */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke="#1e2a3a"
          strokeWidth={strokeWidth}
        />
        {/* Progress arc */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={c}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={offset}
          style={{
            transition: 'stroke-dashoffset 0.7s cubic-bezier(0.4,0,0.2,1), stroke 0.4s ease',
          }}
        />
      </svg>
      {/* Center label */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span className="font-mono font-bold text-lg leading-none text-white tracking-tight">
          {display}
        </span>
        {sub && (
          <span className="font-mono text-[10px] text-gray-500 leading-none">{sub}</span>
        )}
      </div>
    </div>
  );
}
