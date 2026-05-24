import { expect, test } from 'bun:test'

test('lecture launch card module loads', async () => {
  const module = await import('./LectureLaunchCard')
  expect(module.LectureLaunchCard).toBeTruthy()
})
