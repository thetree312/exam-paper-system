export type ExportTemplateInfo = {
  key: string
  name: string
  description: string | null
}

export type ExportQuestionInput = {
  index: number
  markdown: string
}

export type ExportWordInput = {
  title?: string
  templateKey?: string | null
  questions: ExportQuestionInput[]
}
