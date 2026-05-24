import { describe, expect, test } from "bun:test"
import { formatQuestionResponses } from "../../src/tool/question"

describe("formatQuestionResponses", () => {
  test("preserves custom-only free text as the user's answer", () => {
    const formatted = formatQuestionResponses(
      [
        {
          question: "What part is unclear?",
          header: "Check",
          options: [],
        },
      ],
      [
        {
          answers: [],
          freeText: "I do not know",
        },
      ],
    )

    expect(formatted).toBe('"What part is unclear?"=free text "I do not know"')
    expect(formatted).not.toContain("Unanswered")
  })

  test("keeps selected options and free text distinct when both are present", () => {
    const formatted = formatQuestionResponses(
      [
        {
          question: "Choose a path",
          header: "Path",
          options: [],
        },
      ],
      [
        {
          answers: ["A"],
          freeText: "but I am unsure",
        },
      ],
    )

    expect(formatted).toBe('"Choose a path"="A" (free text: "but I am unsure")')
  })
})
