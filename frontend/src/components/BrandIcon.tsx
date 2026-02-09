import React from 'react'

const NeonCircleComponent: React.FC = () => {
  const animations = `
    @keyframes polish {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes drift-simple {
      0%, 100% { transform: scale(1); opacity: 0.4; }
      50% { transform: scale(1.08); opacity: 0.6; }
    }
    @keyframes fog-breath {
      0%, 100% { opacity: 0.15; }
      50% { opacity: 0.3; }
    }
  `

  const ringStyle = (size: string, thickness: string): React.CSSProperties => ({
    width: size,
    height: size,
    background:
      'linear-gradient(135deg, #7f8c8d 0%, #ffffff 15%, #2c3e50 35%, #ffffff 50%, #34495e 70%, #ecf0f1 85%, #95a5a6 100%)',
    backgroundSize: '400% 400%',
    animation: 'polish 12s linear infinite',
    padding: thickness,
    boxShadow:
      '0 0 2px rgba(0, 191, 255, 0.4), inset 0 0 1px rgba(255, 255, 255, 0.8), inset 0 0 2px rgba(0, 0, 0, 0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'absolute',
    borderRadius: '50%',
    zIndex: 10,
    willChange: 'background-position',
  })

  return (
    <div className="relative flex items-center justify-center w-8 h-8 bg-white overflow-visible">
      <style>{animations}</style>

      <svg className="absolute w-0 h-0" aria-hidden="true">
        <filter id="iceFogOpt" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.3" numOctaves="1" seed="5">
            <animate attributeName="seed" dur="15s" values="5;10;5" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" scale="3" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>

      <div className="relative flex items-center justify-center w-full h-full">
        <div
          className="absolute w-[42px] h-[42px] pointer-events-none"
          style={{
            filter: 'url(#iceFogOpt)',
            background: 'radial-gradient(circle at center, rgba(0, 191, 255, 0.6) 0%, transparent 75%)',
            mixBlendMode: 'multiply',
            animation: 'drift-simple 8s ease-in-out infinite',
            zIndex: 5,
            willChange: 'transform, opacity',
          }}
        />

        <div className="relative flex items-center justify-center z-10">
          <div style={ringStyle('28px', '1.2px')}>
            <div className="w-full h-full rounded-full bg-white" />
          </div>

          <div style={ringStyle('18px', '1px')}>
            <div className="w-full h-full rounded-full bg-white" />
          </div>
        </div>

        <div
          className="absolute w-[34px] h-[34px] rounded-full bg-[#81d4fa] blur-[8px] pointer-events-none"
          style={{
            animation: 'fog-breath 5s ease-in-out infinite',
            zIndex: 2,
            willChange: 'opacity',
          }}
        />
      </div>
    </div>
  )
}

export default NeonCircleComponent
