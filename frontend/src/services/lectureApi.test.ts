import { expect, test } from "bun:test"
import * as lectureApi from "./lectureApi"

test("lecture api module loads", () => {
  expect(lectureApi.getLectureSession).toBeTruthy()
})
