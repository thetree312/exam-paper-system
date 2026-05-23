import { expect, test } from "bun:test"

test("lecture route module loads", async () => {
  const module = await import("../src/routes/lectures")
  expect(module.lectureRoutes).toBeTruthy()
})
