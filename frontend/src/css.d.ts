import 'react'

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag' | (string & {})
    [key: `--${string}`]: string | number | undefined
  }
}
