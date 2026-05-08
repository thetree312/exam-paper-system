                

import React from 'react'

const STYLE_TEXT = `
  .mindmap-loading-root {
    --main-color: #a5c7d9;
    --line-color: #b1b1b7;
    --container-width: 320px;
    --container-height: 220px;
    --cycle-speed: 18s;
    --drawer-easing: cubic-bezier(0.4, 0, 0.2, 1);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .mindmap-loading-root .stage {
    position: relative;
    width: var(--container-width);
    height: var(--container-height);
    perspective: 1200px;
  }

  .mindmap-loading-root .panel-container {
    position: absolute;
    inset: 0;
    border-radius: 16px;
    overflow: hidden;
    backface-visibility: hidden;
    will-change: transform, opacity;
    opacity: 0;
    visibility: hidden;
    transform: translateY(110%) scale(0.95);
    z-index: 10;
    animation-fill-mode: both;
  }

  @keyframes mindmap-drawer-logic {
    0%, 1% { transform: translateY(110%) scale(0.95); opacity: 0; visibility: hidden; z-index: 10; }
    6%, 38.5% { transform: translateY(0) scale(1); opacity: 1; visibility: visible; z-index: 30; }
    43%, 100% { transform: translateY(-40px) scale(0.85); opacity: 0; visibility: hidden; z-index: 10; }
  }

  .mindmap-loading-root .panel-1 {
    background: transparent;
    box-shadow: none;
    animation: mindmap-drawer-logic var(--cycle-speed) var(--drawer-easing) infinite;
  }
  .mindmap-loading-root .panel-2 {
    animation: mindmap-drawer-logic var(--cycle-speed) var(--drawer-easing) infinite;
    animation-delay: calc(var(--cycle-speed) / 3);
  }
  .mindmap-loading-root .panel-3 {
    animation: mindmap-drawer-logic var(--cycle-speed) var(--drawer-easing) infinite;
    animation-delay: calc(var(--cycle-speed) * 2 / 3);
  }

  .mindmap-loading-root .border-rect {
    fill: none;
    stroke: var(--main-color);
    stroke-width: 2;
    stroke-dasharray: 8, 8;
    rx: 16;
    animation: mindmap-dash-march 1.2s linear infinite;
  }
  @keyframes mindmap-dash-march {
    from { stroke-dashoffset: 16; }
    to { stroke-dashoffset: 0; }
  }

  .mindmap-loading-root .code-window {
    position: absolute;
    top: 35px;
    left: 30px;
    right: 30px;
    bottom: 80px;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent);
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent);
  }

  .mindmap-loading-root .code-scroll-container {
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: mindmap-seamless-scroll 10s linear infinite;
  }

  @keyframes mindmap-seamless-scroll {
    from { transform: translateY(0); }
    to { transform: translateY(-50%); }
  }

  .mindmap-loading-root .code-line {
    height: 4px;
    background: color-mix(in srgb, var(--main-color) 60%, transparent);
    border-radius: 2px;
    flex-shrink: 0;
    position: relative;
    overflow: hidden;
  }
  .mindmap-loading-root .code-line::after {
    content: '';
    position: absolute;
    inset: 0;
    width: 60%;
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--main-color) 85%, white),
      transparent
    );
    animation: mindmap-scan 2s ease-in-out infinite;
  }
  @keyframes mindmap-scan {
    0% { transform: translateX(-150%); }
    100% { transform: translateX(250%); }
  }

  .mindmap-loading-root .block {
    position: absolute;
    border: 2.5px solid var(--main-color);
    border-radius: 10px;
    box-sizing: border-box;
    animation-duration: 5s;
    animation-iteration-count: infinite;
    animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }

  @keyframes mindmap-move-1 {
    0%, 20% { left: 0; top: 0; width: 200px; height: 104px; }
    25%, 45% { left: 208px; top: 0; width: 110px; height: 104px; }
    50%, 70% { left: 118px; top: 114px; width: 200px; height: 104px; }
    75%, 95% { left: 0; top: 114px; width: 110px; height: 104px; }
    100% { left: 0; top: 0; width: 200px; height: 104px; }
  }
  @keyframes mindmap-move-2 {
    0%, 20% { left: 208px; top: 0; width: 110px; height: 104px; }
    25%, 45% { left: 118px; top: 114px; width: 200px; height: 104px; }
    50%, 70% { left: 0; top: 114px; width: 110px; height: 104px; }
    75%, 95% { left: 0; top: 0; width: 200px; height: 104px; }
    100% { left: 208px; top: 0; width: 110px; height: 104px; }
  }
  @keyframes mindmap-move-3 {
    0%, 20% { left: 118px; top: 114px; width: 200px; height: 104px; }
    25%, 45% { left: 0; top: 114px; width: 110px; height: 104px; }
    50%, 70% { left: 0; top: 0; width: 200px; height: 104px; }
    75%, 95% { left: 208px; top: 0; width: 110px; height: 104px; }
    100% { left: 118px; top: 114px; width: 200px; height: 104px; }
  }
  @keyframes mindmap-move-4 {
    0%, 20% { left: 0; top: 114px; width: 110px; height: 104px; }
    25%, 45% { left: 0; top: 0; width: 200px; height: 104px; }
    50%, 70% { left: 208px; top: 0; width: 110px; height: 104px; }
    75%, 95% { left: 118px; top: 114px; width: 200px; height: 104px; }
    100% { left: 0; top: 114px; width: 110px; height: 104px; }
  }

  .mindmap-loading-root .rf-node {
    background: transparent;
    border: 2.5px solid var(--main-color);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--main-color);
    font-family: monospace;
    font-size: 10px;
    font-weight: bold;
    transform: scale(0);
    opacity: 0;
    position: absolute;
    width: 80px;
    height: 36px;
  }
  .mindmap-loading-root .rf-handle {
    position: absolute;
    width: 5px;
    height: 5px;
    background: var(--main-color);
    border-radius: 50%;
  }
  @keyframes mindmap-rf-pop {
    0%, 5% { transform: scale(0); opacity: 0; }
    8%, 32% { transform: scale(1); opacity: 1; }
    36%, 100% { transform: scale(0); opacity: 0; }
  }
  @keyframes mindmap-rf-link {
    0%, 9% { stroke-dashoffset: 300; opacity: 0; }
    18%, 32% { stroke-dashoffset: 0; opacity: 1; }
    36%, 100% { opacity: 0; }
  }
  @keyframes mindmap-rf-node {
    0%, 20% { transform: scale(0); opacity: 0; }
    24%, 32% { transform: scale(1); opacity: 1; }
    36%, 100% { transform: scale(0); opacity: 0; }
  }

  .mindmap-loading-root .anim-rf-root {
    animation: mindmap-rf-pop var(--cycle-speed) linear infinite;
    animation-delay: calc(var(--cycle-speed) * 2 / 3);
  }
  .mindmap-loading-root .anim-rf-link {
    animation: mindmap-rf-link var(--cycle-speed) linear infinite;
    animation-delay: calc(var(--cycle-speed) * 2 / 3);
  }
  .mindmap-loading-root .anim-rf-node {
    animation: mindmap-rf-node var(--cycle-speed) linear infinite;
    animation-delay: calc(var(--cycle-speed) * 2 / 3);
  }
`

const codeWidths = [40, 90, 60, 20, 70, 90, 40, 60, 90, 40, 75, 30, 85, 50, 65, 95]

interface MindMapLoadingAnimationProps {
  label?: string
  detail?: string | null
}

export const MindMapLoadingAnimation: React.FC<MindMapLoadingAnimationProps> = ({ label, detail }) => (
  <div className="mindmap-loading-root pointer-events-none select-none flex-col gap-4">
    <style>{STYLE_TEXT}</style>
    <div className="stage">
      <div className="panel-container panel-1">
        <svg className="absolute inset-0 z-[5]" viewBox="0 0 320 220">
          <rect className="border-rect" x="1" y="1" width="318" height="218" />
        </svg>
        <div className="code-window">
          <div className="code-scroll-container">
            {codeWidths.map((w, i) => (
              <div key={`code-a-${i}`} className="code-line" style={{ width: `${w}%` }} />
            ))}
            {codeWidths.map((w, i) => (
              <div key={`code-b-${i}`} className="code-line" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
        <div className="absolute bottom-[25px] left-[25px] w-10 h-10 rounded-full border-2 border-[var(--main-color)] flex justify-center items-center bg-[#0f0f0f]">
          <span className="text-[--main-color] font-mono font-bold text-xs">{'</>'}</span>
        </div>
      </div>

      <div className="panel-container panel-2 !bg-transparent shadow-none">
        <div className="relative w-full h-full">
          <div className="block" style={{ animationName: 'mindmap-move-1' }} />
          <div className="block" style={{ animationName: 'mindmap-move-2' }} />
          <div className="block" style={{ animationName: 'mindmap-move-3' }} />
          <div className="block" style={{ animationName: 'mindmap-move-4' }} />
        </div>
      </div>

      <div className="panel-container panel-3 !bg-transparent shadow-none">
        <div className="relative w-full h-full">
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            <path
              className="anim-rf-link fill-none stroke-[var(--main-color)] stroke-[1.5]"
              strokeDasharray="300"
              strokeDashoffset="300"
              d="M100 110 C 140 110, 160 50, 210 50"
              style={{ animationDelay: 'calc(var(--cycle-speed) * 2/3 + 0.2s)' }}
            />
            <path
              className="anim-rf-link fill-none stroke-[var(--main-color)] stroke-[1.5]"
              strokeDasharray="300"
              strokeDashoffset="300"
              d="M100 110 C 160 110, 160 110, 210 110"
              style={{ animationDelay: 'calc(var(--cycle-speed) * 2/3 + 0.4s)' }}
            />
            <path
              className="anim-rf-link fill-none stroke-[var(--main-color)] stroke-[1.5]"
              strokeDasharray="300"
              strokeDashoffset="300"
              d="M100 110 C 140 110, 160 170, 210 170"
              style={{ animationDelay: 'calc(var(--cycle-speed) * 2/3 + 0.6s)' }}
            />
          </svg>

          <div className="rf-node anim-rf-root left-[20px] top-[92px]">
            INPUT
            <div className="rf-handle right-[-3px] top-[14px]" />
          </div>

          {['LOGIC A', 'LOGIC B', 'OUTPUT'].map((label, index) => (
            <div
              key={label}
              className="rf-node anim-rf-node left-[210px]"
              style={{
                top: `${32 + index * 60}px`,
                animationDelay: `calc(var(--cycle-speed) * 2/3 + ${0.8 + index * 0.2}s)`,
              }}
            >
              <div className="rf-handle left-[-3px] top-[14px]" />
              {label}
            </div>
          ))}
        </div>
      </div>
    </div>
    {(label || detail) && (
      <div className="max-w-[420px] rounded-2xl border border-[var(--ui-border-default)]/80 bg-[var(--ui-bg-elevated)] px-4 py-3 text-center shadow-[0_16px_40px_rgba(15,23,42,0.12)] backdrop-blur">
        {label && <div className="text-sm font-semibold text-[var(--ui-text-primary)]">{label}</div>}
        {detail && <div className="mt-1 text-xs text-[var(--ui-text-primary)]">{detail}</div>}
      </div>
    )}
  </div>
)

export default MindMapLoadingAnimation


