import React from 'react'
import { LectureLaunchGlassButton } from './LectureLaunchGlassButton'
import { useAppStore } from '../store/appStore'

interface LectureLaunchCardProps {
  onOpen: () => void
}

interface MagicCardProps {
  children: React.ReactNode
  className?: string
  gradientColor: string
  gradientSize?: number
  beamCore: string
  style?: React.CSSProperties
}

const borderMask: React.CSSProperties = {
  WebkitMask:
    'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
  WebkitMaskComposite: 'xor',
  mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
  maskComposite: 'exclude',
}

const MagicCard: React.FC<MagicCardProps> = ({
  children,
  className = '',
  gradientColor,
  gradientSize = 220,
  beamCore,
  style,
}) => {
  const moveSpotlight = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--x', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--y', `${event.clientY - rect.top}px`)
  }

  const hideSpotlight = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty('--x', `-${gradientSize}px`)
    event.currentTarget.style.setProperty('--y', `-${gradientSize}px`)
  }

  return (
    <div
      className={`magic-card group relative overflow-hidden rounded-[24px] border ${className}`}
      style={{
        ...style,
        ['--x' as '--x']: `-${gradientSize}px`,
        ['--y' as '--y']: `-${gradientSize}px`,
        ['--gradient-size' as '--gradient-size']: `${gradientSize}px`,
        ['--gradient-color' as '--gradient-color']: gradientColor,
        ['--beam-core' as '--beam-core']: beamCore,
      }}
      onPointerMove={moveSpotlight}
      onPointerLeave={hideSpotlight}
    >
      <div className="relative z-10 rounded-[inherit]">{children}</div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] p-px opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          ...borderMask,
          background:
            'radial-gradient(var(--gradient-size) circle at var(--x) var(--y), var(--beam-core) 0%, var(--gradient-color) 26%, color-mix(in srgb, var(--gradient-color) 55%, transparent) 46%, transparent 72%)',
        }}
      />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-px rounded-[inherit] p-[2px] opacity-0 blur-[2px] transition-opacity duration-200 group-hover:opacity-100"
        style={{
          ...borderMask,
          background:
            'radial-gradient(calc(var(--gradient-size) * 0.75) circle at var(--x) var(--y), color-mix(in srgb, var(--beam-core) 85%, transparent), var(--gradient-color) 36%, transparent 74%)',
        }}
      />
    </div>
  )
}

export const LectureLaunchCard: React.FC<LectureLaunchCardProps> = ({ onOpen }) => {
  const theme = useAppStore((state) => state.theme)
  const isDark = theme === 'dark'

  const themeVars = isDark
    ? {
        ['--magic-card-gradient' as '--magic-card-gradient']:
          'rgb(from var(--ui-text-primary) r g b / 0.22)',
        ['--magic-card-beam-core' as '--magic-card-beam-core']:
          'rgb(from var(--ui-text-primary) r g b / 0.9)',
      }
    : {
        ['--magic-card-gradient' as '--magic-card-gradient']:
          'rgb(from var(--ui-accent) r g b / 0.55)',
        ['--magic-card-beam-core' as '--magic-card-beam-core']:
          'rgb(from var(--ui-accent) r g b / 0.88)',
      }

  const cardStyle: React.CSSProperties = {
    background: isDark
      ? 'rgb(from var(--ui-bg-agent) r g b / 0.82)'
      : 'rgb(from var(--ui-bg-agent) r g b / 0.78)',
    borderColor: isDark
      ? 'rgb(from var(--ui-border-default) r g b / 0.72)'
      : 'rgb(from var(--ui-border-default) r g b / 0.72)',
    color: 'var(--ui-text-primary)',
    boxShadow: isDark
      ? '0 8px 18px rgba(0, 0, 0, 0.14)'
      : '0 10px 20px rgba(148, 163, 184, 0.12)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  }

  return (
    <div
      className="flex justify-center py-2"
      style={themeVars}
      aria-label="讲解入口卡片"
    >
      <MagicCard
        gradientColor="var(--magic-card-gradient)"
        beamCore="var(--magic-card-beam-core)"
        className="w-full max-w-[360px]"
        style={cardStyle}
      >
        <div className="flex min-h-[128px] items-center justify-center px-6 py-6">
          <div className="flex items-center justify-center">
            <LectureLaunchGlassButton onOpen={onOpen} overLight={!isDark} />
          </div>
        </div>
      </MagicCard>
    </div>
  )
}
