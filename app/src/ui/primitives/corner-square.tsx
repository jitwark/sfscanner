export type CornerSquarePosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type CornerSquareSize = 'sm' | 'md' | 'lg';

export type CornerSquareProps = {
  position?: CornerSquarePosition;
  size?: CornerSquareSize;
  className?: string;
};

const POSITION_CLASSES: Record<CornerSquarePosition, string> = {
  'top-left': 'top-0 left-0',
  'top-right': 'top-0 right-0',
  'bottom-left': 'bottom-0 left-0',
  'bottom-right': 'bottom-0 right-0',
};

const SIZE_CLASSES: Record<CornerSquareSize, string> = {
  sm: 'w-2 h-2',
  md: 'w-3 h-3',
  lg: 'w-4 h-4',
};

/**
 * The signature decorative corner square.
 * An unrounded solid green block anchored to a card or panel corner.
 */
export function CornerSquare({
  position = 'top-left',
  size = 'md',
  className = '',
}: CornerSquareProps) {
  return (
    <span
      aria-hidden="true"
      data-corner-square
      className={`absolute ${POSITION_CLASSES[position]} ${SIZE_CLASSES[size]} bg-accent pointer-events-none ${className}`}
    />
  );
}
