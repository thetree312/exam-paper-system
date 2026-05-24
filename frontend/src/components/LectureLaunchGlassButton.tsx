import React from 'react'
import LiquidGlass from 'liquid-glass-react'
import Icon from './Icon'

interface LectureLaunchGlassButtonProps {
  onOpen: () => void
  overLight: boolean
}

export const LectureLaunchGlassButton: React.FC<LectureLaunchGlassButtonProps> = ({
  onOpen,
  overLight,
}) => {
  const shellStyle: React.CSSProperties = overLight
    ? {
        background: 'transparent',
        filter: 'none',
        transform: 'scale(1)',
        opacity: 0,
      }
    : {
        background: `
          radial-gradient(circle at 24% 30%, rgb(from var(--ui-text-tool-call) r g b / 0.16) 0%, transparent 40%),
          radial-gradient(circle at 74% 66%, rgb(from var(--ui-accent) r g b / 0.14) 0%, transparent 36%),
          linear-gradient(
            135deg,
            rgb(from var(--ui-bg-agent) r g b / 0.12),
            rgb(from var(--ui-bg-panel-muted) r g b / 0.22)
          )
        `,
        filter: 'blur(10px)',
        transform: 'scale(1.06)',
        opacity: 0.78,
      }

  return (
    <>
      <div
        className="lecture-launch-glass-shell relative h-[60px] w-[184px]"
        style={{
          ['--lecture-glass-shadow' as '--lecture-glass-shadow']: overLight
            ? '0 3px 12px rgba(15, 23, 42, 0.08)'
            : '0 3px 10px rgba(0, 0, 0, 0.12)',
          ['--lecture-glass-edge-shadow' as '--lecture-glass-edge-shadow']: overLight
            ? '0 0 0 0.5px rgba(255, 255, 255, 0.42) inset, 0 1px 2px rgba(255, 255, 255, 0.2) inset, 0 1px 2px rgba(15, 23, 42, 0.08)'
            : '0 0 0 0.5px rgba(255, 255, 255, 0.24) inset, 0 1px 2px rgba(255, 255, 255, 0.1) inset, 0 1px 2px rgba(0, 0, 0, 0.14)',
        }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full"
          style={shellStyle}
        />

        <LiquidGlass
          onClick={onOpen}
          mode="shader"
          displacementScale={64}
          blurAmount={0.1}
          saturation={130}
          aberrationIntensity={2}
          elasticity={0.18}
          cornerRadius={100}
          padding="10px 22px"
          overLight={overLight}
          className="lecture-launch-glass-button"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: '184px',
            height: '60px',
          }}
        >
          <span
            className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap text-[14px] font-medium leading-none"
            style={{
              color: 'var(--ui-text-primary)',
              letterSpacing: 0,
            }}
            aria-label="进入讲解"
          >
            <Icon
              name="play_lesson"
              className="shrink-0 text-[18px]"
              aria-hidden="true"
            />
            <span>进入讲解</span>
          </span>
        </LiquidGlass>
      </div>

      <style>{`
        .lecture-launch-glass-button {
          isolation: isolate;
        }

        .lecture-launch-glass-shell > div:first-child,
        .lecture-launch-glass-shell > div:nth-child(2) {
          border-radius: 999px;
        }

        .lecture-launch-glass-button .glass {
          width: 100% !important;
          height: 100% !important;
          display: inline-flex !important;
          align-items: center;
          justify-content: center;
          gap: 0;
          white-space: nowrap;
          box-shadow: var(--lecture-glass-shadow) !important;
        }

        .lecture-launch-glass-button .glass > div:last-child {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          white-space: nowrap;
        }

        .lecture-launch-glass-shell > span {
          box-shadow: var(--lecture-glass-edge-shadow) !important;
        }
      `}</style>
    </>
  )
}
