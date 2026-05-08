import React from 'react'
import { z } from 'zod'
import {
  BuiltinActionType,
  type ComponentRenderProps,
  type ParseResult,
  Renderer,
  createLibrary,
  defineComponent,
  useGetFieldValue,
  useFormName,
  useSetDefaultValue,
  useSetFieldValue,
  useTriggerAction,
} from '@openuidev/react-lang'

type ContinuePayload = {
  params: Record<string, any>
  formState: Record<string, any>
}

type HitlFieldProps = {
  formName: string
  name: string
  label: string
  kind: string
  placeholder?: string
  required?: boolean
  optionValues?: string[]
  optionLabels?: string[]
  defaultValue?: any
  min?: number | null
  max?: number | null
}

type HitlActionProps = {
  id: string
  label: string
  variant?: string
  formName?: string
}

type HitlFormProps = {
  title: string
  formName: string
  fields: any[]
  actions: any[]
}

const hitlField = defineComponent({
  name: 'HitlField',
  description: 'Single HITL form field',
  props: z.object({
    formName: z.string(),
    name: z.string(),
    label: z.string(),
    kind: z.string(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    optionValues: z.array(z.string()).optional(),
    optionLabels: z.array(z.string()).optional(),
    defaultValue: z.any().optional(),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
  }),
  component: ({ props }: ComponentRenderProps<HitlFieldProps>) => {
    const {
      formName,
      name,
      label,
      kind,
      placeholder,
      optionValues = [],
      optionLabels = [],
      defaultValue,
      min,
      max,
    } = props
    const getFieldValue = useGetFieldValue()
    const setFieldValue = useSetFieldValue()
    const value = getFieldValue(formName, name)
    useSetDefaultValue({
      formName,
      componentType: kind,
      name,
      existingValue: value,
      defaultValue,
      shouldTriggerSaveCallback: false,
    })

    const normalized = value == null ? '' : value
    if (kind === 'select') {
      return (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--ui-text-primary)]">{label}</label>
          <select
            value={String(normalized)}
            onChange={(e) => setFieldValue(formName, kind, name, e.target.value, false)}
            className="w-full rounded-md border border-[var(--ui-border-strong)] px-2 py-1.5 text-sm bg-[var(--ui-bg-panel)] focus:outline-none focus:ring-1 focus:ring-[var(--ui-border-strong)]"
          >
            {optionValues.map((optValue, idx) => (
              <option key={`${name}-${optValue}-${idx}`} value={optValue}>
                {optionLabels[idx] ?? optValue}
              </option>
            ))}
          </select>
        </div>
      )
    }

    if (kind === 'radio') {
      return (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-[var(--ui-text-primary)]">{label}</label>
          <div className="grid gap-1.5">
            {optionValues.map((optValue, idx) => {
              const checked = String(normalized) === optValue
              return (
                <label
                  key={`${name}-${optValue}-${idx}`}
                  className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition ${
                    checked ? 'border-slate-500 bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)]' : 'border-[var(--ui-border-strong)] text-[var(--ui-text-primary)]'
                  }`}
                >
                  <input
                    type="radio"
                    name={name}
                    value={optValue}
                    checked={checked}
                    onChange={(e) => setFieldValue(formName, kind, name, e.target.value, false)}
                  />
                  <span>{optionLabels[idx] ?? optValue}</span>
                </label>
              )
            })}
          </div>
        </div>
      )
    }

    if (kind === 'textarea') {
      return (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--ui-text-primary)]">{label}</label>
          <textarea
            value={String(normalized)}
            placeholder={placeholder || ''}
            onChange={(e) => setFieldValue(formName, kind, name, e.target.value, false)}
            className="w-full min-h-20 rounded-md border border-[var(--ui-border-strong)] px-2 py-1.5 text-sm bg-[var(--ui-bg-panel)] focus:outline-none focus:ring-1 focus:ring-[var(--ui-border-strong)]"
          />
        </div>
      )
    }

    if (kind === 'number') {
      return (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--ui-text-primary)]">{label}</label>
          <input
            type="number"
            min={typeof min === 'number' ? min : undefined}
            max={typeof max === 'number' ? max : undefined}
            value={normalized === '' ? '' : Number(normalized)}
            onChange={(e) => setFieldValue(formName, kind, name, e.target.value === '' ? '' : Number(e.target.value), false)}
            className="w-full rounded-md border border-[var(--ui-border-strong)] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--ui-border-strong)]"
          />
        </div>
      )
    }

    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs text-[var(--ui-text-primary)]">{label}</label>
        <input
          type="text"
          value={String(normalized)}
          placeholder={placeholder || ''}
          onChange={(e) => setFieldValue(formName, kind, name, e.target.value, false)}
          className="w-full rounded-md border border-[var(--ui-border-strong)] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--ui-border-strong)]"
        />
      </div>
    )
  },
})

const hitlAction = defineComponent({
  name: 'HitlAction',
  description: 'HITL form action button',
  props: z.object({
    id: z.string(),
    label: z.string(),
    variant: z.string().optional(),
    formName: z.string().optional(),
  }),
  component: ({ props }: ComponentRenderProps<HitlActionProps>) => {
    const { id, label, variant, formName: explicitFormName } = props
    const triggerAction = useTriggerAction()
    const contextFormName = useFormName()
    const formName = explicitFormName || contextFormName
    const isPrimary = (variant || '').toLowerCase() === 'primary'
    return (
      <button
        type="button"
        onClick={() =>
          triggerAction(label, formName, {
            type: BuiltinActionType.ContinueConversation,
            params: { actionId: id },
          })
        }
        className={
          isPrimary
            ? 'px-3 py-1.5 rounded-full text-xs bg-slate-900 text-white'
            : 'px-3 py-1.5 rounded-full text-xs border border-[var(--ui-border-strong)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)] transition'
        }
      >
        {label}
      </button>
    )
  },
})

const hitlForm = defineComponent({
  name: 'HitlForm',
  description: 'HITL interrupt form container',
  props: z.object({
    title: z.string(),
    formName: z.string(),
    fields: z.array(hitlField.ref),
    actions: z.array(hitlAction.ref),
  }),
  component: ({ props, renderNode }: ComponentRenderProps<HitlFormProps>) => {
    const { title, fields, actions } = props
    return (
      <div className="rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-elevated)] shadow-sm px-4 py-3">
        {title ? <div className="text-xs font-semibold text-[var(--ui-text-primary)] mb-2">{title}</div> : null}
        <div className="space-y-3">{fields.map((field, idx) => <React.Fragment key={`field-${idx}`}>{renderNode(field)}</React.Fragment>)}</div>
        <div className="pt-2 flex justify-end gap-2">
          {actions.map((action, idx) => (
            <React.Fragment key={`action-${idx}`}>{renderNode(action)}</React.Fragment>
          ))}
        </div>
      </div>
    )
  },
})

const hitlOpenUiLibrary = createLibrary({
  root: 'HitlForm',
  components: [hitlForm, hitlField, hitlAction],
})

export function OpenUiHitlRenderer({
  response,
  onContinue,
}: {
  response: string
  onContinue: (payload: ContinuePayload) => void
}) {
  const [parseError, setParseError] = React.useState<string | null>(null)
  const handleParseResult = React.useCallback((result: ParseResult | null) => {
    if (!result) {
      setParseError('OpenUI parse result is empty')
      return
    }
    const errors = Array.isArray(result.meta?.validationErrors) ? result.meta.validationErrors : []
    if (errors.length > 0) {
      const first = errors[0]
      const msg = first?.message ? String(first.message) : 'OpenUI validation failed'
      setParseError(msg)
      return
    }
    if (!result.root) {
      setParseError('OpenUI root node is empty')
      return
    }
    setParseError(null)
  }, [])

  if (parseError) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {parseError}
      </div>
    )
  }

  return (
    <Renderer
      response={response}
      library={hitlOpenUiLibrary}
      onParseResult={handleParseResult}
      onAction={(event) => {
        if (event.type !== BuiltinActionType.ContinueConversation) return
        onContinue({
          params: event.params || {},
          formState: (event.formState || {}) as Record<string, any>,
        })
      }}
    />
  )
}


