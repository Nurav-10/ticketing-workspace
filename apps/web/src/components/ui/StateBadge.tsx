import type { HTMLAttributes, ReactNode } from 'react'

type StateTone = 'neutral' | 'warning' | 'success' | 'danger'

type StateBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  children: ReactNode
  tone?: StateTone
}

export function StateBadge({ children, className, tone = 'neutral', ...props }: StateBadgeProps) {
  const classes = ['ui-state-badge', className].filter(Boolean).join(' ')

  return (
    <span {...props} className={classes} data-tone={tone}>
      <span className="ui-state-badge__dot" aria-hidden="true" />
      {children}
    </span>
  )
}
