const CANVAS_RUNTIME_IMPORT_RE =
  /import\s+\{\s*LectureCanvasRuntime\s*\}\s+from\s+["'](?:lecture-canvas-runtime|\/wiki\/\.agent\/lib\/lecture-canvas-runtime\/index\.js)["'];?/g

export function normalizeLectureVisualizationHTML(html: string) {
  return html
    .replace(/^\uFEFF/, '')
    .replace(/<script\b[^>]*\btype=(?:"importmap"|'importmap')[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(CANVAS_RUNTIME_IMPORT_RE, 'const { LectureCanvasRuntime } = window;')
}
