import { expect, test } from "bun:test"

test("lecture studio panel module loads", async () => {
  const module = await import("./LectureStudioPanel")
  expect(module.LectureStudioPanel).toBeTruthy()
})
