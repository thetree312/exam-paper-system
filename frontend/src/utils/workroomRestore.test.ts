// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'

import type { AgentSnapshotResponse } from '../types'
import { buildOcrItemsFromSnapshot } from './workroomRestore'

test('buildOcrItemsFromSnapshot maps snapshot questions into ordered OCR cards', () => {
  const snapshot: AgentSnapshotResponse = {
    document_id: 88,
    title: '2025 Mock Paper.pdf',
    status: 'draft',
    questions: [
      {
        id: 502,
        sequenceIndex: 1,
        groupId: 9002,
        page: 3,
        content: 'Q2 content',
        legendImages: ['/legend/q2.png'],
        studentAnswer: 'B',
        gradingJudgement: 'incorrect',
        gradingPredictedAnswer: 'C',
        gradingReasoning: 'reasoning 2',
        gradingConfidence: 0.4,
      },
      {
        id: 501,
        sequenceIndex: 0,
        groupId: 9001,
        page: 2,
        content: 'Q1 content',
        legendImages: ['/legend/q1.png'],
        studentAnswer: 'A',
        gradingJudgement: 'correct',
        gradingPredictedAnswer: 'A',
        gradingReasoning: 'reasoning 1',
        gradingConfidence: 0.96,
      },
    ],
  }

  const items = buildOcrItemsFromSnapshot(snapshot, {
    sessionId: 77,
    fileId: 66,
    fileName: 'Recovered.pdf',
    createdAt: 1_700_000_000_000,
  })

  assert.equal(items.length, 2)
  assert.equal(items[0].text, 'Q1 content')
  assert.equal(items[0].region_index, 0)
  assert.equal(items[0].questionMeta?.questionId, 501)
  assert.equal(items[0].questionMeta?.sequenceIndex, 0)
  assert.equal(items[0].questionMeta?.groupId, 9001)
  assert.equal(items[0].answerText, 'A')
  assert.equal(items[0].grading?.status, 'correct')
  assert.equal(items[1].text, 'Q2 content')
  assert.equal(items[1].region_index, 1)
  assert.equal(items[1].questionMeta?.questionId, 502)
  assert.equal(items[1].grading?.predictedAnswer, 'C')
})

test('buildOcrItemsFromSnapshot falls back to snapshot title and zero ids when tab context is missing', () => {
  const snapshot: AgentSnapshotResponse = {
    document_id: 88,
    title: 'Recovered Title.pdf',
    status: 'draft',
    questions: [
      {
        id: 501,
        sequenceIndex: 0,
        page: null,
        content: 'Only question',
        legendImages: [],
      },
    ],
  }

  const items = buildOcrItemsFromSnapshot(snapshot, {
    createdAt: 1_700_000_000_000,
  })

  assert.equal(items[0].fileName, 'Recovered Title.pdf')
  assert.equal(items[0].fileId, 0)
  assert.equal(items[0].sessionId, 0)
  assert.equal(items[0].page, 1)
  assert.equal(items[0].originalText, 'Only question')
})
