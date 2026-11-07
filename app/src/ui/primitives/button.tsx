import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'outline'
  | 'outline-on-dark'
  | 'secondary'
  | 'ghost'
  | 'ghost-link';
export type ButtonSize = '36' | '44';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
};

export function Button({
  variant = 'primary',
  size = '36',
  className = '',
  disabled,
  children,
  ...props
}: ButtonProps) {
  const baseClasses =
    'inline-flex items-center justify-center font-sans font-bold rounded-control transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-accent-border focus-visible:outline-offset-2 disabled:bg-raised disabled:text-ink-muted/50 disabled:border-transparent disabled:cursor-not-allowed';

  const sizeClasses =
    variant === 'ghost-link'
      ? 'h-auto p-0 text-sm'
      : size === '44'
        ? 'h-11 px-6 text-base'
        : 'h-9 px-3.5 text-sm';

  const variantClasses =
    variant === 'primary'
      ? 'bg-accent text-accent-ink hover:brightness-95 active:brightness-90'
      : variant === 'outline'
        ? 'bg-transparent text-ink border-2 border-accent-border hover:bg-accent/10'
        : variant === 'outline-on-dark'
          ? 'bg-transparent text-on-band border border-on-band hover:bg-white/10'
          : variant === 'secondary'
            ? 'bg-raised text-ink border border-hairline hover:border-hairline-strong'
            : variant === 'ghost-link'
              ? 'bg-transparent text-accent-text hover:underline'
              : 'bg-transparent text-ink-muted hover:text-ink hover:bg-raised/50';

  return (
    <button
      type="button"
      className={`${baseClasses} ${sizeClasses} ${variantClasses} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
