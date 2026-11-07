import type { HTMLAttributes } from 'react';

export type SkeletonProps = HTMLAttributes<HTMLDivElement> & {
  width?: string | number;
  height?: string | number;
};

export function Skeleton({
  width,
  height,
  className = '',
  style,
  ...props
}: SkeletonProps) {
  const customStyle = {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...style,
  };

  return (
    <div
      className={`bg-raised/50 animate-pulse motion-reduce:animate-none rounded-control ${className}`}
      style={customStyle}
      aria-hidden="true"
      {...props}
    />
  );
}
