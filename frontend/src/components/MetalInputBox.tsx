import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import Icon from './Icon'
import LobeIcon from './LobeIcon'
import type { ModelSelectOption } from '../lib/modelBranding'
import { createPlainTextMathDocument, mathContentToPromptText } from '../lib/mathContent'
import { MathContentEditor } from './math/MathContentEditor'
import type { AgentInputFile } from '../types'

interface MetalInputBoxProps {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void
  placeholder?: string
  disabled?: boolean
  inputHeight: number
  onHeightChange?: (height: number) => void
  sendButtonSize: number
  onSend?: () => void
  onStop?: () => void
  canSend?: boolean
  isGenerating?: boolean
  selectedModel?: string
  onModelChange?: (modelOptionID: string) => void
  modelOptions?: ModelSelectOption[]
  onOpenSkillSettings?: () => void
  onOpenMcpSettings?: () => void
  onUploadAgentFiles?: (files: AgentInputFile[]) => void
  attachedFileNames?: string[]
  mathInputEnabled: boolean
  backendBaseUrl: string
  userId: string | number
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
  onStop,
  canSend = true,
  isGenerating = false,
  selectedModel = '',
  onModelChange,
  modelOptions = [{ modelID: 'GPT-4o' }],
  onOpenSkillSettings,
  onOpenMcpSettings,
  onUploadAgentFiles,
  attachedFileNames = [],
  mathInputEnabled,
  backendBaseUrl,
  userId,
}) => {
  const editorFrameRef = useRef<HTMLDivElement | null>(null)
  const resizeRafRef = useRef<number | null>(null)
  const lastHeightRef = useRef<number>(inputHeight)
  const [showPanel, setShowPanel] = useState(false)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const updateHeight = useCallback(() => {
    const frame = editorFrameRef.current
    if (!frame) return
    const scrollHeight = frame.scrollHeight
    const clampedHeight = Math.min(Math.max(scrollHeight, 34), 120)
    if (lastHeightRef.current === clampedHeight) return
    lastHeightRef.current = clampedHeight
    onHeightChange?.(clampedHeight)
  }, [onHeightChange])

  const scheduleHeightUpdate = useCallback(() => {
    if (resizeRafRef.current != null) return
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null
      updateHeight()
    })
  }, [updateHeight])

  const handleChange = (nextValue: string) => {
    onChange(nextValue)
    scheduleHeightUpdate()
  }

  const togglePanel = () => {
    setShowPanel(!showPanel)
    if (!showPanel) setShowModelMenu(false)
  }

  const toggleModelMenu = () => {
    setShowModelMenu(!showModelMenu)
    if (!showModelMenu) setShowPanel(false)
  }

  const closeAllPanels = () => {
    setShowPanel(false)
    setShowModelMenu(false)
  }

  const readTextFileAsUtf8 = useCallback(async (file: File) => {
    const buffer = await file.arrayBuffer()
    const decoder = new TextDecoder('utf-8')
    return decoder.decode(buffer)
  }, [])

  const handleSelectAgentFile = useCallback(async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(evt.target.files ?? [])
    evt.target.value = ''
    if (!files.length) return

    const supported = files.filter((file) => {
      const lower = file.name.toLowerCase()
      return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')
    })
    if (!supported.length) return

    const parsed: AgentInputFile[] = []
    for (const file of supported) {
      const text = (await readTextFileAsUtf8(file)).trim()
      if (!text) continue
      parsed.push({
        name: file.name,
        mimeType: file.type || 'text/plain',
        content: text,
      })
    }
    if (parsed.length > 0) {
      onUploadAgentFiles?.(parsed)
    }
  }, [onUploadAgentFiles, readTextFileAsUtf8])

  const selectedModelOption =
    modelOptions.find((item) => (item.optionID || item.modelID) === selectedModel) ??
    {
      optionID: selectedModel,
      modelID: selectedModel,
    }

  const editorValue = useMemo(
    () => createPlainTextMathDocument(value),
    [value],
  )

  useEffect(() => {
    lastHeightRef.current = inputHeight
  }, [inputHeight])

  useEffect(() => {
    scheduleHeightUpdate()
  }, [scheduleHeightUpdate, value])

  useEffect(() => {
    const frame = editorFrameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => scheduleHeightUpdate())
    observer.observe(frame)
    return () => {
      observer.disconnect()
      if (resizeRafRef.current != null) {
        window.cancelAnimationFrame(resizeRafRef.current)
        resizeRafRef.current = null
      }
    }
  }, [scheduleHeightUpdate])

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

        .metal-outer-container {
          position: relative;
          padding: 2px;
          border-radius: 20px;
          background: var(--polished-metal);
          background-size: 300% 300%;
          animation: reflectRotate 12s linear infinite;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }

        .metal-inner-card {
          background: #ffffff;
          border-radius: 18px;
          display: flex;
          flex-direction: column;
          box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.06);
          position: relative;
          min-height: 72px;
          overflow: visible;
        }

        .textarea-wrapper {
          flex: 1;
          padding: 8px 12px 0px 12px;
        }

        .metal-editor-frame {
          width: 100%;
        }

        .metal-editor-frame .math-content-editor {
          border: none;
          padding: 0;
          background: transparent;
          border-radius: 0;
          box-shadow: none;
          min-height: 34px;
          text-align: left;
        }

        .metal-editor-frame .math-content-editor p,
        .metal-editor-frame .math-content-editor [data-math-inline],
        .metal-editor-frame .math-content-editor [data-math-block] {
          text-align: left;
        }

        .metal-editor-frame .math-content-editor:focus,
        .metal-editor-frame .math-content-editor:focus-visible {
          outline: none;
        }

        .bottom-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 2px 6px 6px 6px;
          border-top: none;
        }

        .left-tools {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .tool-btn {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          border: none;
          background: transparent;
          color: #8e8e93;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }

        .tool-btn:hover {
          background: #f2f2f7;
          color: #1c1c1e;
        }

        .model-capsule {
          height: 28px;
          padding: 0 6px;
          border-radius: 8px;
          background: transparent;
          border: none;
          display: flex;
          align-items: center;
          gap: 4px;
          cursor: pointer;
          transition: all 0.2s;
          color: #8e8e93;
          min-width: 0;
          max-width: 168px;
          flex: 0 1 168px;
        }

        .model-capsule:hover {
          background: #f2f2f7;
          color: #1c1c1e;
        }

        .model-label {
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 120px;
          display: inline-block;
        }

        .send-action {
          display: flex;
          align-items: center;
        }

        .metal-send-btn {
          border: none;
          background: #1c1c1e;
          border-radius: 10px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s, background 0.2s;
        }

        .metal-send-btn:hover:not(:disabled) {
          background: #000000;
          transform: scale(1.02);
        }

        .metal-send-btn:disabled {
          background: #d1d1d6;
          cursor: not-allowed;
        }

        .popover {
          position: absolute;
          bottom: 100%;
          left: 0;
          margin-bottom: 8px;
          background: rgba(255, 255, 255, 0.98);
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.15);
          padding: 6px;
          min-width: 220px;
          max-width: min(72vw, 320px);
          z-index: 50;
          border: 1px solid rgba(0,0,0,0.05);
          backdrop-filter: blur(10px);
        }

        .menu-row {
          padding: 10px 12px;
          font-size: 14px;
          cursor: pointer;
          border-radius: 10px;
          display: flex;
          align-items: center;
          gap: 10px;
          color: #1c1c1e;
          white-space: nowrap;
          min-width: 0;
        }

        .menu-row:hover {
          background: #f2f2f7;
        }

        .menu-option-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }

      `}</style>

      <div className="metal-outer-container">
        <div className="metal-inner-card">
          {attachedFileNames.length > 0 && (
            <div className="px-3 pt-2 pb-1 flex flex-wrap gap-1.5">
              {attachedFileNames.map((name) => (
                <span
                  key={name}
                  className="inline-flex max-w-full items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600"
                  title={name}
                >
                  <Icon name={"description"} className="text-[12px] mr-1 text-slate-500" />
                  <span className="truncate max-w-[200px]">{name}</span>
                </span>
              ))}
            </div>
          )}
          <div className="textarea-wrapper">
            <div ref={editorFrameRef} className="metal-editor-frame" style={{ minHeight: `${inputHeight}px` }}>
              <MathContentEditor
                value={editorValue}
                onChange={(nextDoc) => handleChange(mathContentToPromptText(nextDoc))}
                placeholder={placeholder}
                disabled={disabled}
                minHeight={inputHeight}
                maxHeight={120}
                onKeyDown={onKeyDown}
                mathInputEnabled={mathInputEnabled}
                backendBaseUrl={backendBaseUrl}
                userId={userId}
              />
            </div>
          </div>

          <div className="bottom-toolbar">
            <div className="left-tools">
              <div className="relative">
                <button type="button" className="tool-btn" onClick={togglePanel}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                {showPanel && (
                  <div className="popover">
                    <div
                      className="menu-row"
                      onClick={() => {
                        closeAllPanels()
                        fileInputRef.current?.click()
                      }}
                    >
                      <Icon name={"upload_file"} className="text-[16px] leading-none text-slate-500" />
                      上传文档（md/txt）
                    </div>
                    <div
                      className="menu-row"
                      onClick={() => {
                        closeAllPanels()
                        onOpenMcpSettings?.()
                      }}
                    >
                      <Icon name={"build_circle"} className="text-[16px] leading-none text-slate-500" />
                      MCP
                    </div>
                    <div
                      className="menu-row"
                      onClick={() => {
                        closeAllPanels()
                        onOpenSkillSettings?.()
                      }}
                    >
                      <Icon name={"blur_on"} className="text-[16px] leading-none text-slate-500" />
                      Skill
                    </div>
                  </div>
                )}
              </div>

              <div className="relative">
                <div className="model-capsule" onClick={toggleModelMenu}>
                  <LobeIcon
                    iconKey={selectedModelOption.modelIconKey || selectedModelOption.providerIconKey}
                    fallbackIconName="memory"
                    className="text-[14px] leading-none"
                  />
                  <span
                    className="model-label"
                    title={selectedModelOption.label || selectedModelOption.modelID || '选择模型'}
                  >
                    {selectedModelOption.label || selectedModelOption.modelID || '选择模型'}
                  </span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </div>
                {showModelMenu && (
                  <div className="popover">
                    {modelOptions.length > 0 ? (
                      modelOptions.map((option) => (
                        <div
                          key={option.optionID || option.modelID}
                          className="menu-row"
                          onClick={() => {
                            onModelChange?.(option.optionID || option.modelID)
                            closeAllPanels()
                          }}
                        >
                          <LobeIcon
                            iconKey={option.modelIconKey || option.providerIconKey}
                            fallbackIconName="memory"
                            className="text-[14px] leading-none"
                          />
                          <div style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            backgroundColor: selectedModel === (option.optionID || option.modelID) ? '#34c759' : '#d1d1d6',
                          }} />
                          <span className="menu-option-text">{option.label || option.modelID}</span>
                        </div>
                      ))
                    ) : (
                      <div className="menu-row text-slate-400" style={{ cursor: 'default' }}>
                        暂无可选模型
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="send-action">
              <button
                type="button"
                className="metal-send-btn"
                style={{ width: sendButtonSize, height: sendButtonSize }}
                onClick={() => {
                  closeAllPanels()
                  if (isGenerating) {
                    onStop?.()
                  } else {
                    onSend?.()
                  }
                }}
                disabled={isGenerating ? false : ((!canSend) || disabled)}
              >
                {isGenerating ? (
                  <div style={{ width: 12, height: 12, background: 'white', borderRadius: 2 }} />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,text/plain,text/markdown"
          multiple
          className="hidden"
          onChange={handleSelectAgentFile}
        />
      </div>
    </>
  )
}
