import type { HTMLAttributes, ReactNode } from 'react';
import { CornerSquare, type CornerSquarePosition } from './corner-square';

export type PanelProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  raised?: boolean;
  interactive?: boolean;
  cornerSquare?: boolean | CornerSquarePosition;
};

export function Panel({
  children,
  raised = false,
  interactive = false,
  cornerSquare,
  className = '',
  ...props
}: PanelProps) {
  const bgClass = raised ? 'bg-raised' : 'bg-panel';
  const interactiveClass = interactive
    ? 'hover:border-hairline-strong transition-colors duration-120 cursor-pointer'
    : '';

  const squarePosition: CornerSquarePosition | null =
    cornerSquare === true ? 'top-left' : typeof cornerSquare === 'string' ? cornerSquare : null;

  return (
    <div
      className={`relative ${bgClass} border border-hairline rounded-panel p-4 ${interactiveClass} ${className}`}
      {...props}
    >
      {squarePosition && <CornerSquare position={squarePosition} />}
      {children}
    </div>
  );
}
