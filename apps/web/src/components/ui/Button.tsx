import { forwardRef, type ButtonHTMLAttributes } from 'react'

type ButtonVariant = 'ghost' | 'subtle' | 'outline'
type ButtonSize = 'small' | 'medium' | 'icon'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, size = 'medium', type = 'button', variant = 'ghost', ...props },
  ref,
) {
  const classes = ['ui-button', `ui-button--${variant}`, `ui-button--${size}`, className]
    .filter(Boolean)
    .join(' ')

  return <button {...props} ref={ref} className={classes} type={type} />
})
