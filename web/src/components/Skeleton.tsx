import React from 'react';

export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`card p-4 animate-pulse ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="h-2.5 w-24 bg-gray-800 rounded" />
        <div className="h-2 w-16 bg-gray-800 rounded" />
      </div>
      <div className="h-7 w-20 bg-gray-800 rounded mb-2" />
      <div className="h-2 w-full bg-gray-800 rounded mb-1" />
      <div className="h-2 w-3/4 bg-gray-800 rounded" />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 last:border-0 animate-pulse">
      <div className="w-2 h-2 rounded-full bg-gray-800 flex-shrink-0" />
      <div className="h-3 w-28 bg-gray-800 rounded" />
      <div className="h-3 w-20 bg-gray-800 rounded" />
      <div className="h-3 w-24 bg-gray-800 rounded ml-auto" />
    </div>
  );
}

export function SkeletonText({ width = 'w-32', height = 'h-3' }: { width?: string; height?: string }) {
  return <div className={`${width} ${height} bg-gray-800 rounded animate-pulse`} />;
}
