type IconName = 'inbox' | 'user' | 'layers' | 'search' | 'plus' | 'chevron' | 'menu' | 'close' | 'sliders' | 'dots'

const common = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function Icon({ name }: { name: IconName }) {
  switch (name) {
    case 'inbox': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><path d="M3.5 5.5h13v10h-13zM3.5 11.5h4l1.2 1.7h2.6l1.2-1.7h4" /></svg>
    case 'user': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><circle cx="10" cy="6.5" r="2.7" /><path d="M4.5 16c.5-2.6 2.4-4 5.5-4s5 1.4 5.5 4" /></svg>
    case 'layers': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><path d="m10 3 7 3.6-7 3.7-7-3.7L10 3Z" /><path d="m3 10 7 3.7 7-3.7M3 13.3 10 17l7-3.7" /></svg>
    case 'search': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><circle cx="8.7" cy="8.7" r="5.2" /><path d="m12.5 12.5 4 4" /></svg>
    case 'plus': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><path d="M10 4v12M4 10h12" /></svg>
    case 'chevron': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><path d="m7.5 8.5 2.5 2.5 2.5-2.5" /></svg>
    case 'menu': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><path d="M3 6h14M3 10h14M3 14h14" /></svg>
    case 'close': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><path d="m5 5 10 10M15 5 5 15" /></svg>
    case 'sliders': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" /><circle cx="7" cy="5.5" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="10" r="1.5" fill="currentColor" stroke="none" /><circle cx="8.5" cy="14.5" r="1.5" fill="currentColor" stroke="none" /></svg>
    case 'dots': return <svg viewBox="0 0 20 20" aria-hidden="true" {...common}><circle cx="4.5" cy="10" r="1" fill="currentColor" /><circle cx="10" cy="10" r="1" fill="currentColor" /><circle cx="15.5" cy="10" r="1" fill="currentColor" /></svg>
  }
}
