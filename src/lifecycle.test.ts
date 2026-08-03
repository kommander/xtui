import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { destroy, run } from "./index.js"

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  } as Response
}

function timelinePosts(start: number, count: number): Array<{ id: string; text: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: String(start + index), text: `Post ${start + index}` }))
}

test("ignores a pagination response after renderer destruction", async () => {
  const setup = await createTestRenderer({ width: 80, height: 12 })
  const originalFetch = globalThis.fetch
  const originalAppData = process.env.APPDATA
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
  const configHome = mkdtempSync(join(process.cwd(), ".xtui-lifecycle-test-"))
  const unhandled: unknown[] = []
  const onUnhandledRejection = (error: unknown) => unhandled.push(error)
  let resolvePagination: (response: Response) => void = () => {}
  const paginationResponse = new Promise<Response>((resolve) => {
    resolvePagination = resolve
  })
  let paginationRequested: () => void = () => {}
  const paginationRequest = new Promise<void>((resolve) => {
    paginationRequested = resolve
  })
  let requestCount = 0

  globalThis.fetch = (async () => {
    requestCount += 1
    if (requestCount === 1) {
      return jsonResponse({ data: { id: "1", name: "Test User", username: "test" } })
    }
    if (requestCount === 2) {
      return jsonResponse({ data: timelinePosts(1, 20), meta: { next_token: "next-page" } })
    }
    paginationRequested()
    return paginationResponse
  }) as unknown as typeof fetch
  process.env.APPDATA = configHome
  process.env.XDG_CONFIG_HOME = configHome
  process.on("unhandledRejection", onUnhandledRejection)

  try {
    run(setup.renderer, { detectedBrowsers: [] })
    setup.mockInput.pressEnter()
    await setup.mockInput.typeText("test-token")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Post 1"))

    for (let index = 0; index < 15; index += 1) setup.mockInput.pressKey("j")
    await paginationRequest
    expect(requestCount).toBe(3)

    setup.mockInput.pressKey("q")
    expect(setup.renderer.isDestroyed).toBe(true)
    resolvePagination(jsonResponse({ data: timelinePosts(21, 1), meta: {} }))
    await Bun.sleep(0)

    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandledRejection)
    globalThis.fetch = originalFetch
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    destroy()
    rmSync(configHome, { recursive: true, force: true })
  }
})
