import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FavoriteConfig } from '../types'
import { getQuestionTypes, createQuestionType } from '../services/questionTypesApi'
import { getSubjects, createSubject } from '../services/subjectsApi'
import { getTags, createTag } from '../services/tagsApi'

interface FavoriteConfigDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: (config: FavoriteConfig) => void
  backendBaseUrl: string
  tenantId: number
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
}

// 默认题型选项
const DEFAULT_QUESTION_TYPES = [
  '单选题',
  '多选题',
  '填空题',
  '解答题',
  '判断题',
  '简答题',
]

// 默认科目选项
const DEFAULT_SUBJECTS = [
  '语文',
  '英语',
  '数学',
  '物理',
  '化学',
  '生物',
  '历史',
  '地理',
  '政治',
]

// 默认知识点标签
const DEFAULT_KNOWLEDGE_TAGS = [
  '重点',
  '难点',
  '易错',
  '高频',
  '必考',
  '应用',
  '综合',
]

/**
 * Select with Custom Entry 组件
 * 下拉列表显示预设选项，最后一项是带输入框的自定义条目
 */
interface SelectWithCustomEntryProps {
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
  disabled?: boolean
}

const SelectWithCustomEntry: React.FC<SelectWithCustomEntryProps> = ({
  value,
  onChange,
  options,
  placeholder = '选择或输入...',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const customInputRef = useRef<HTMLInputElement>(null)

  // 处理外部点击关闭下拉框
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleOptionClick = (option: string) => {
    onChange(option)
    setIsOpen(false)
    setCustomInput('')
  }

  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setCustomInput(newValue)
    onChange(newValue)
  }

  const handleCustomInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && customInput.trim()) {
      setIsOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {/* 显示框 */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-left bg-white hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:cursor-not-allowed flex items-center justify-between"
      >
        <span className="text-gray-900">
          {value || placeholder}
        </span>
        <span className="material-symbols-outlined text-[18px] text-gray-400">
          {isOpen ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {/* 下拉列表 */}
      {isOpen && !disabled && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded-md shadow-lg z-10">
          <div className="max-h-48 overflow-y-auto">
            {/* 预设选项 */}
            {options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => handleOptionClick(option)}
                className={`w-full text-left px-3 py-2 hover:bg-blue-50 transition ${
                  value === option
                    ? 'bg-blue-100 text-blue-900'
                    : 'text-gray-900'
                }`}
              >
                {option}
              </button>
            ))}

            {/* 自定义条目 - 带输入框 */}
            <div className="border-t px-3 py-2 bg-gray-50">
              <input
                ref={customInputRef}
                type="text"
                value={customInput}
                onChange={handleCustomInputChange}
                onKeyDown={handleCustomInputKeyDown}
                placeholder="输入自定义值..."
                className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const FavoriteConfigDialog: React.FC<FavoriteConfigDialogProps> = ({
  open,
  onClose,
  onConfirm,
  backendBaseUrl,
  tenantId,
  onToast,
}) => {
  const { t } = useTranslation('common')
  // 数据加载状态
  const [isLoading, setIsLoading] = useState(false)
  const [questionTypeOptions, setQuestionTypeOptions] = useState<string[]>([])
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])
  const [tagOptions, setTagOptions] = useState<string[]>([])

  // 题型选择状态
  const [selectedQuestionType, setSelectedQuestionType] = useState('')

  // 科目选择状态
  const [selectedSubject, setSelectedSubject] = useState('')

  // 标签选择状态
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([])
  const [newTagInput, setNewTagInput] = useState('')

  // 提交状态
  const [isSubmitting, setIsSubmitting] = useState(false)

  // 加载数据
  useEffect(() => {
    if (!open) return

    let cancelled = false
    setIsLoading(true)

    Promise.all([
      getQuestionTypes(backendBaseUrl, tenantId),
      getSubjects(backendBaseUrl, tenantId),
      getTags(backendBaseUrl, tenantId),
    ])
      .then(([types, subjects, tags]) => {
        if (!cancelled) {
          // 合并默认选项和获取的选项
          const typeNames = types.map((t) => t.name)
          const mergedTypes = mergeWithDefaults(typeNames, DEFAULT_QUESTION_TYPES)
          
          const subjectNames = subjects.map((s) => s.name)
          const mergedSubjects = mergeWithDefaults(subjectNames, DEFAULT_SUBJECTS)
          
          const tagNames = tags.map((t) => t.name)
          const mergedTags = mergeWithDefaults(tagNames, DEFAULT_KNOWLEDGE_TAGS)
          
          setQuestionTypeOptions(mergedTypes)
          setSubjectOptions(mergedSubjects)
          setTagOptions(mergedTags)
        }
      })
      .catch((err) => {
        console.error('[FavoriteConfigDialog] load data failed', err)
        if (!cancelled) {
          onToast?.(t('favorite_config.errors.load_failed'), 'error')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, backendBaseUrl, tenantId, onToast])

  // 合并默认选项和获取的选项
  const mergeWithDefaults = (fetched: string[], defaults: string[]): string[] => {
    const fetchedSet = new Set(fetched)
    const defaultsNotInFetched = defaults.filter((d) => !fetchedSet.has(d))
    return [...defaultsNotInFetched, ...fetched]
  }

  const handleConfirm = async () => {
    if (isSubmitting) return

    setIsSubmitting(true)

    try {
      let finalQuestionTypeId: number | undefined
      let finalSubjectId: number | undefined
      const selectedTagNames: string[] = []

      // 处理题型
      if (selectedQuestionType.trim()) {
        const newType = await createQuestionType(
          backendBaseUrl,
          tenantId,
          selectedQuestionType.trim(),
        )
        finalQuestionTypeId = newType.id
      }

      // 处理科目
      if (selectedSubject.trim()) {
        const newSubject = await createSubject(
          backendBaseUrl,
          tenantId,
          selectedSubject.trim(),
        )
        finalSubjectId = newSubject.id
      }

      // 收集选中的标签名称
      selectedTagIds.forEach((index) => {
        if (index < tagOptions.length) {
          selectedTagNames.push(tagOptions[index])
        }
      })

      // 处理新标签
      if (newTagInput.trim()) {
        selectedTagNames.push(newTagInput.trim())
      }

      // 为每个标签名称创建或获取tag
      const tagIds: number[] = []
      for (const tagName of selectedTagNames) {
        const tag = await createTag(backendBaseUrl, tenantId, tagName)
        tagIds.push(tag.id)
      }

      const config: FavoriteConfig = {
        question_type_id: finalQuestionTypeId,
        subject_id: finalSubjectId,
        tag_ids: tagIds,
        new_tag_names: [],
      }

      onConfirm(config)
      onClose()
    } catch (err) {
      console.error('[FavoriteConfigDialog] confirm failed', err)
      const errorMsg = err instanceof Error ? err.message : t('favorite_config.errors.operation_failed')
      onToast?.(errorMsg, 'error')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    // 重置状态
    setSelectedQuestionType('')
    setSelectedSubject('')
    setSelectedTagIds([])
    setNewTagInput('')
    onClose()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        {/* 标题 */}
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('favorite_config.title')}</h2>
          <button
            onClick={handleClose}
            className="text-gray-500 hover:text-gray-700"
            disabled={isSubmitting}
          >
            ✕
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-6">
          {isLoading ? (
            <div className="text-center py-8 text-gray-500">{t('favorite_config.loading')}</div>
          ) : (
            <>
              {/* 题型选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('favorite_config.question_type_label')}
                </label>
                <SelectWithCustomEntry
                  value={selectedQuestionType}
                  onChange={setSelectedQuestionType}
                  options={questionTypeOptions}
                  placeholder={t('favorite_config.question_type_placeholder')}
                  disabled={isSubmitting}
                />
              </div>

              {/* 科目选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('favorite_config.subject_label')}
                </label>
                <SelectWithCustomEntry
                  value={selectedSubject}
                  onChange={setSelectedSubject}
                  options={subjectOptions}
                  placeholder={t('favorite_config.subject_placeholder')}
                  disabled={isSubmitting}
                />
              </div>

              {/* 标签选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('favorite_config.tags_label')}
                </label>
                <div className="space-y-3">
                  {/* 已有标签列表 */}
                  <div className="flex flex-wrap gap-2">
                    {tagOptions.map((tag, index) => (
                      <button
                        key={`${tag}-${index}`}
                        type="button"
                        onClick={() => {
                          setSelectedTagIds((prev) =>
                            prev.includes(index)
                              ? prev.filter((id) => id !== index)
                              : [...prev, index],
                          )
                        }}
                        className={`px-3 py-1 rounded-full text-sm transition ${
                          selectedTagIds.includes(index)
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                        }`}
                        disabled={isSubmitting}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>

                  {/* 新标签输入 */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      placeholder={t('favorite_config.tags_custom_placeholder')}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      disabled={isSubmitting}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newTagInput.trim()) {
                          e.preventDefault()
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="sticky bottom-0 bg-white border-t px-6 py-4 flex gap-3 justify-end">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            disabled={isSubmitting || isLoading}
          >
            {t('favorite_config.buttons.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            disabled={isSubmitting || isLoading}
          >
            {isSubmitting ? t('favorite_config.buttons.confirming') : t('favorite_config.buttons.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
