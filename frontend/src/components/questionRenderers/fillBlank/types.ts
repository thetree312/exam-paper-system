export interface FillBlankTextSegment {
  type: 'text'
  text: string
}

export interface FillBlankBlankSegment {
  type: 'blank'
  index: number
  /**
   * 原始占位长度，用于估算下划线宽度（例如 "______" 长度为 6）。
   */
  placeholderLength: number
}

export type FillBlankSegment = FillBlankTextSegment | FillBlankBlankSegment

export interface FillBlankParsedResult {
  segments: FillBlankSegment[]
  totalBlanks: number
  originalText: string
}

export type FillBlankAnswerMap = Record<number, string>
