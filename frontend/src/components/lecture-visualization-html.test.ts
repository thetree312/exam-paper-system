import { describe, expect, test } from 'bun:test'
import { normalizeLectureVisualizationHTML } from './lecture-visualization-html'

describe('lecture visualization html normalization', () => {
  test('removes model import maps and rewrites canvas runtime imports to the host global', () => {
    const html = '\uFEFF<script type="importmap">{"imports":{"lecture-canvas-runtime":"/wiki/.agent/lib/lecture-canvas-runtime/index.js"}}</script><canvas id="orbit"></canvas><script type="module">import { LectureCanvasRuntime } from "lecture-canvas-runtime";\nconst runtime = LectureCanvasRuntime.mountCanvas(document.getElementById("orbit"), drawScene);</script>'

    const normalized = normalizeLectureVisualizationHTML(html)

    expect(normalized.startsWith('\uFEFF')).toBe(false)
    expect(normalized).not.toContain('type="importmap"')
    expect(normalized).not.toContain('from "lecture-canvas-runtime"')
    expect(normalized).toContain('const { LectureCanvasRuntime } = window;')
  })
})
