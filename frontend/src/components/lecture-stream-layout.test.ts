import { describe, expect, test } from 'bun:test'
import { buildLectureStreamRenderItems } from './lecture-stream-layout'
import type { LectureBlockDto, LectureDraftBlockDto, LectureReasoningDraftDto } from '../services/lectureApi'

function createBlock(id: string, text: string): LectureBlockDto {
  return {
    id,
    sessionID: 'lecture-session',
    role: 'lecture',
    text,
    createdAt: '2026-05-23T16:00:00.000Z',
    highlightSpans: [],
    pauseAfter: false,
  }
}

function createReasoning(status: LectureReasoningDraftDto['status']): LectureReasoningDraftDto {
  return {
    id: 'reasoning_1',
    sessionID: 'lecture-session',
    text: 'Let me think...',
    createdAt: '2026-05-23T16:00:00.000Z',
    elapsedMs: 4800,
    status,
  }
}

function createDraft(text: string): LectureDraftBlockDto {
  return {
    id: 'draft_1',
    sessionID: 'lecture-session',
    role: 'lecture',
    text,
    createdAt: '2026-05-23T16:00:01.000Z',
  }
}

describe('lecture stream layout', () => {
  test('renders completed reasoning above the latest committed block', () => {
    const items = buildLectureStreamRenderItems({
      blocks: [createBlock('block_1', '正文')],
      reasoningDraft: createReasoning('complete'),
      draftBlock: null,
    })

    expect(items.map((item) => item.kind)).toEqual(['reasoning', 'block'])
  })

  test('keeps active reasoning after committed blocks while the next segment is still thinking', () => {
    const items = buildLectureStreamRenderItems({
      blocks: [createBlock('block_1', '上一段正文')],
      reasoningDraft: createReasoning('thinking'),
      draftBlock: null,
    })

    expect(items.map((item) => item.kind)).toEqual(['block', 'reasoning'])
  })

  test('places reasoning above the streaming draft block', () => {
    const items = buildLectureStreamRenderItems({
      blocks: [createBlock('block_1', '上一段正文')],
      reasoningDraft: createReasoning('complete'),
      draftBlock: createDraft('新正文草稿'),
    })

    expect(items.map((item) => item.kind)).toEqual(['block', 'reasoning', 'block'])
    expect(items[2]).toMatchObject({
      kind: 'block',
      streaming: true,
      block: {
        id: 'draft_1',
        text: '新正文草稿',
        highlightSpans: [],
      },
    })
  })
})
