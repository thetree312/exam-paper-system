import React from 'react'
import { DotmCircular7 } from './ui/dotm-circular-7'

interface LectureGateShiftIndicatorProps {
  className?: string
}

export const LectureGateShiftIndicator: React.FC<LectureGateShiftIndicatorProps> = ({ className }) => {
  return (
    <div
      className={className ?? 'inline-flex items-center justify-center rounded-full px-1 py-1 text-[var(--ui-text-primary)]'}
      aria-label="老师正在继续讲解"
      title="老师正在继续讲解"
    >
      <DotmCircular7 size={22} dotSize={3} speed={1.2} bloom ariaLabel="老师正在继续讲解" />
    </div>
  )
}
