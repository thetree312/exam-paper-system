import React, { useRef, useEffect, useState } from 'react'

interface MetalInputBoxProps {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  disabled?: boolean
  inputHeight: number
  onHeightChange?: (height: number) => void
  sendButtonSize: number
  onSend?: () => void
  canSend?: boolean
}

export const MetalInputBox: React.FC<MetalInputBoxProps> = ({
  value,
  onChange,
  onKeyDown,
  placeholder = '输入消息...',
  disabled = false,
  inputHeight,
  onHeightChange,
  sendButtonSize,
  onSend,
  canSend = true,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [animationFrameId, setAnimationFrameId] = useState<number | null>(null)

  const updateHeight = () => {
    if (animationFrameId) cancelAnimationFrame(animationFrameId)

    const frameId = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.style.height = 'auto'
      const scrollHeight = textarea.scrollHeight
      const clampedHeight = Math.min(Math.max(scrollHeight, 36), 200)
      textarea.style.height = `${clampedHeight}px`
      textarea.style.overflowY = scrollHeight >= 200 ? 'auto' : 'hidden'
      onHeightChange?.(clampedHeight)
    })
    setAnimationFrameId(frameId)
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    updateHeight()
  }

  useEffect(() => {
    updateHeight()
  }, [])

  return (
    <>
      <style>{`
        :root {
          --polished-metal: linear-gradient(135deg, 
            #a2a2a7 0%, 
            #e7e7e9 15%, 
            #ffffff 20%, 
            #d1d1d6 30%, 
            #ffffff 45%, 
            #8e8e93 55%, 
            #ffffff 70%, 
            #d1d1d6 85%, 
            #a2a2a7 100%);
        }

        @keyframes reflectRotate {
          0% { background-position: 0% 0%; }
          50% { background-position: 100% 100%; }
          100% { background-position: 0% 0%; }
        }

        @keyframes sweep {
          0% { transform: translateX(-150%) skewX(-25deg); }
          100% { transform: translateX(150%) skewX(-25deg); }
        }

        .metal-input-case {
          position: relative;
          padding: 2px;
          border-radius: 20px;
          background: var(--polished-metal);
          background-size: 300% 300%;
          box-shadow: 
            0 15px 35px rgba(0, 0, 0, 0.12),
            inset 0 0.5px 1px rgba(255, 255, 255, 1),
            inset 0 -0.5px 0.5px rgba(0, 0, 0, 0.2);
          animation: reflectRotate 10s linear infinite;
          transform: translateZ(0);
          will-change: background-position;
          width: 100%;
          overflow: hidden;
          outline: none !important;
          border: none !important;
          box-shadow: 0 15px 35px rgba(0, 0, 0, 0.12), inset 0 0.5px 1px rgba(255, 255, 255, 1), inset 0 -0.5px 0.5px rgba(0, 0, 0, 0.2) !important;
        }

        .metal-input-case:focus-within {
          outline: none !important;
          border: none !important;
          box-shadow: 0 15px 35px rgba(0, 0, 0, 0.12), inset 0 0.5px 1px rgba(255, 255, 255, 1), inset 0 -0.5px 0.5px rgba(0, 0, 0, 0.2) !important;
        }

        .metal-input-case::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          width: 50%;
          height: 100%;
          background: linear-gradient(to right, 
            transparent, 
            rgba(255, 255, 255, 0.3), 
            transparent);
          transform: skewX(-25deg);
          animation: sweep 6s ease-in-out infinite;
          pointer-events: none;
          z-index: 1;
        }

        .metal-input-inner {
          background: #ffffff;
          border-radius: 18px;
          display: flex;
          flex-direction: column;
          box-shadow: 
            inset 0 2px 5px rgba(0, 0, 0, 0.1),
            inset 0 1px 1px rgba(0, 0, 0, 0.05);
          position: relative;
          z-index: 2;
          outline: none !important;
          border: none !important;
        }

        .metal-textarea {
          width: 100%;
          min-height: 36px;
          max-height: 200px;
          border: none;
          padding: 10px 16px 36px 16px;
          font-size: 14px;
          line-height: 1.5;
          color: #1c1c1e;
          outline: none !important;
          resize: none;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: transparent;
          overflow-y: hidden;
          display: block;
          caret-color: #007aff;
          box-shadow: none !important;
        }

        .metal-textarea:focus {
          outline: none !important;
          box-shadow: none !important;
          border: none;
        }

        .metal-action-bar {
          position: absolute;
          bottom: 6px;
          left: 8px;
          right: 8px;
          height: 32px;
          display: flex;
          justify-content: flex-end;
          align-items: center;
          pointer-events: none;
          z-index: 10;
        }

        .metal-send-btn {
          pointer-events: auto;
          position: relative;
          border: none;
          background: transparent;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background-color 150ms;
          flex-shrink: 0;
          outline: none;
          overflow: hidden;
        }

        .metal-send-btn::after {
          content: "";
          position: absolute;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.08);
          opacity: 0;
          border-radius: 50%;
          transform: scale(0);
          transition: transform 0.4s cubic-bezier(0.1, 0.7, 1.0, 0.1), opacity 0.3s;
        }

        .metal-send-btn:active::after {
          transform: scale(2);
          opacity: 1;
          transition: 0s;
        }

        .metal-send-icon {
          width: 20px;
          height: 20px;
          fill: #8e8e93;
          pointer-events: none;
          transition: fill 0.2s;
        }

        .metal-send-btn:hover .metal-send-icon {
          fill: #1c1c1e;
        }

        .metal-send-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>

      <div className="metal-input-case">
        <div className="metal-input-inner">
          <textarea
            ref={textareaRef}
            className="metal-textarea"
            placeholder={placeholder}
            value={value}
            onChange={handleChange}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={1}
            style={{ height: `${inputHeight}px` }}
            aria-label="输入消息"
          />

          <div className="metal-action-bar">
            <button
              className="metal-send-btn"
              style={{
                height: `${sendButtonSize}px`,
                width: `${sendButtonSize}px`,
              }}
              onClick={onSend}
              disabled={!canSend || disabled}
              aria-label="发送消息"
            >
              <svg className="metal-send-icon" viewBox="0 0 24 24">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
