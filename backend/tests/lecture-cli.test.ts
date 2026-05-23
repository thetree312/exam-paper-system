import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Writable } from "node:stream"

process.env.STUDIO_QUESTION_CARDS_SCOPE_WORKROOM_ID = "workroom-test"
process.env.STUDIO_QUESTION_CARDS_BRIDGE_BASE_URL = "http://127.0.0.1:3000"
process.env.STUDIO_QUESTION_CARDS_BRIDGE_TOKEN = "bridge-token"

const { runLectureCli } = await import("../src/cli/lecture")

test("runLectureCli preserves chinese and latex payload through utf8 file transport", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({
      url: String(url),
      body,
    })
    return new Response(JSON.stringify({ ok: true, block: { id: "block-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const stdoutChunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(String(chunk))
      callback()
    },
  })

  const tempDir = path.join(process.cwd(), "tmp", "tests", "lecture-cli")
  const textPath = path.join(tempDir, "lecture-block-utf8.txt")
  try {
    mkdirSync(tempDir, { recursive: true })
    writeFileSync(textPath, "$$\\frac{a^3}{T^2}=k$$\n第二行：中文 $a=6r_{地}$", "utf8")
    process.env.LECTURE_HIGHLIGHT_SPANS = JSON.stringify([
      { sourceId: "stem", quote: "第二行：中文 $a=6r_{地}$" },
    ])
    const exitCode = await runLectureCli(
      [
        "append-block",
        "--session-id",
        "lecture-session-1",
        "--role",
        "system",
        "--text-file",
        textPath,
        "--delete-after-read",
        "--highlight-spans-env",
        "LECTURE_HIGHLIGHT_SPANS",
      ],
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
      },
    )

    assert.equal(exitCode, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, "http://127.0.0.1:3000/api/lectures/lecture-session-1/block")
    assert.equal(calls[0]?.body.text, "$$\\frac{a^3}{T^2}=k$$\n第二行：中文 $a=6r_{地}$")
    assert.deepEqual(calls[0]?.body.highlightSpans, [
      { sourceId: "stem", quote: "第二行：中文 $a=6r_{地}$" },
    ])
    assert.equal(await Bun.file(textPath).exists(), false)
    assert.match(stdoutChunks.join(""), /"ok": true/)
  } finally {
    delete process.env.LECTURE_HIGHLIGHT_SPANS
    globalThis.fetch = originalFetch
  }
})

test("runLectureCli reads text from file and deletes it when requested", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ url: String(url), body })
    return new Response(JSON.stringify({ ok: true, block: { id: "block-file" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

  const tempDir = path.join(process.cwd(), "tmp", "tests", "lecture-cli")
  mkdirSync(tempDir, { recursive: true })
  const textPath = path.join(tempDir, "lecture-block.txt")
  writeFileSync(textPath, "$$T^2 \\propto a^3$$\n中文段落", { encoding: "utf8" })

  try {
    const exitCode = await runLectureCli(
      [
        "append-block",
        "--session-id",
        "lecture-session-file",
        "--role",
        "system",
        "--text-file",
        textPath,
        "--delete-after-read",
      ],
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
      },
    )

    assert.equal(exitCode, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.body.text, "$$T^2 \\propto a^3$$\n中文段落")
    assert.equal(await Bun.file(textPath).exists(), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("runLectureCli rejects lecture text append-block because runtime stream owns lecture content", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("fetch should not be called")
  }) as typeof fetch

  const stdoutChunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(String(chunk))
      callback()
    },
  })

  const tempDir = path.join(process.cwd(), "tmp", "tests", "lecture-cli")
  const textPath = path.join(tempDir, "lecture-block-rejected.txt")
  try {
    mkdirSync(tempDir, { recursive: true })
    writeFileSync(textPath, "这段正文必须走 runtime assistant stream。", "utf8")
    const exitCode = await runLectureCli(
      [
        "append-block",
        "--session-id",
        "lecture-session-runtime-only",
        "--role",
        "lecture",
        "--text-file",
        textPath,
      ],
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
      },
    )

    assert.equal(exitCode, 1)
    assert.match(stdoutChunks.join(""), /LECTURE_TEXT_RUNTIME_STREAM_ONLY/)
    assert.equal(await Bun.file(textPath).exists(), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("runLectureCli sends lecture answer payload with highlight spans", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({
      url: String(url),
      body,
    })
    return new Response(JSON.stringify({ ok: true, session: { id: "lecture-session-2" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

  const tmpDir = path.join(process.cwd(), "tmp", "tests", "lecture-cli")
  const answerPath = path.join(tmpDir, "lecture-answer-utf8.txt")
  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(answerPath, "我想先验证 D。", "utf8")
    process.env.LECTURE_HIGHLIGHT_SPANS = JSON.stringify([
      { sourceId: "stem", quote: "我想先验证 D。" },
    ])
    const exitCode = await runLectureCli(
      [
        "answer",
        "--session-id",
        "lecture-session-2",
        "--text-file",
        answerPath,
        "--delete-after-read",
        "--highlight-spans-env",
        "LECTURE_HIGHLIGHT_SPANS",
      ],
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
      },
    )

    assert.equal(exitCode, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, "http://127.0.0.1:3000/api/lectures/lecture-session-2/answer")
    assert.equal(calls[0]?.body.text, "我想先验证 D。")
    assert.equal(await Bun.file(answerPath).exists(), false)
  } finally {
    delete process.env.LECTURE_HIGHLIGHT_SPANS
    globalThis.fetch = originalFetch
  }
})

test("runLectureCli sends lecture visualization patch payload", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({
      url: String(url),
      body,
    })
    return new Response(JSON.stringify({ ok: true, session: { id: "lecture-session-3" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

  const tmpDir = path.join(process.cwd(), "tmp", "tests", "lecture-cli")
  const patchPath = path.join(tmpDir, "visualization-patch-primary.json")
  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(
      patchPath,
      JSON.stringify([
        {
          op: "set_text",
          targetId: "viz-title",
          text: "新的标题",
        },
      ]),
      "utf8",
    )
    const exitCode = await runLectureCli(
      [
        "render-html-patch",
        "--session-id",
        "lecture-session-3",
        "--patch-file",
        patchPath,
        "--delete-after-read",
      ],
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
      },
    )

    assert.equal(exitCode, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, "http://127.0.0.1:3000/api/lectures/lecture-session-3/visualization")
    assert.deepEqual(calls[0]?.body.patches, [
      {
        op: "set_text",
        targetId: "viz-title",
        text: "新的标题",
      },
    ])
    assert.equal(await Bun.file(patchPath).exists(), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("runLectureCli reads visualization html from a utf8 file payload", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({
      url: String(url),
      body,
    })
    return new Response(JSON.stringify({ ok: true, session: { id: "lecture-session-4" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

  const tmpDir = path.join(process.cwd(), "tmp", "tests", "lecture-cli")
  const htmlPath = path.join(tmpDir, "visualization-utf8.html")

  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(htmlPath, "<svg><text>近日点与远日点</text></svg>", "utf8")
    const exitCode = await runLectureCli(
      [
        "render-html",
        "--session-id",
        "lecture-session-4",
        "--html-file",
        htmlPath,
        "--delete-after-read",
      ],
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
      },
    )

    assert.equal(exitCode, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, "http://127.0.0.1:3000/api/lectures/lecture-session-4/visualization")
    assert.equal(calls[0]?.body.html, "<svg><text>近日点与远日点</text></svg>")
    assert.equal(await Bun.file(htmlPath).exists(), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("runLectureCli reads visualization patch from a utf8 file payload and deletes it", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ url: String(url), body })
    return new Response(JSON.stringify({ ok: true, session: { id: "lecture-session-5" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })

  const tmpDir = path.join(process.cwd(), "tmp", "tests", "lecture-cli")
  const patchPath = path.join(tmpDir, "visualization-patch-utf8.json")

  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(
      patchPath,
      JSON.stringify([{ op: "set_text", targetId: "viz-title", text: "新的标题" }]),
      "utf8",
    )
    const exitCode = await runLectureCli(
      [
        "render-html-patch",
        "--session-id",
        "lecture-session-5",
        "--patch-file",
        patchPath,
        "--delete-after-read",
      ],
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
      },
    )

    assert.equal(exitCode, 0)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.body.patches, [
      { op: "set_text", targetId: "viz-title", text: "新的标题" },
    ])
    assert.equal(await Bun.file(patchPath).exists(), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("runLectureCli rejects full html passed as visualization patch file payload", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("fetch should not be called")
  }) as typeof fetch

  const stdoutChunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(String(chunk))
      callback()
    },
  })

  const tmpDir = path.join(process.cwd(), "tmp", "tests", "lecture-cli")
  const invalidPatchPath = path.join(tmpDir, "invalid-patch.html")
  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(invalidPatchPath, "<!doctype html><html><body>not a patch</body></html>", "utf8")
    const exitCode = await runLectureCli(
      [
        "render-html-patch",
        "--session-id",
        "lecture-session-4",
        "--patch-file",
        invalidPatchPath,
        "--delete-after-read",
      ],
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
      },
    )

    assert.equal(exitCode, 1)
    assert.match(stdoutChunks.join(""), /patch-env must contain a JSON array|patch must contain a JSON array/)
    assert.equal(await Bun.file(invalidPatchPath).exists(), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
