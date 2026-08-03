import { describe, expect, test } from "bun:test"
import {
  BoxRenderable,
  CliRenderEvents,
  TextAttributes,
  type CliRendererErrorEvent,
  type CliRendererHandlerErrorEvent,
  type Renderable,
} from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { destroy, run } from "./index.js"

const TIMELINE_QUERY = {
  max_results: "20",
  "tweet.fields": "attachments,author_id,created_at,entities,public_metrics,referenced_tweets",
  expansions:
    "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id",
  "user.fields": "id,name,profile_image_url,username",
  "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width",
} as const

interface JsonReply {
  body: unknown
  status?: number
  headers?: HeadersInit
}

interface ExpectedRequest {
  label: string
  token: string
  pathname: string
  query: Record<string, string>
  reply: () => JsonReply | Promise<JsonReply>
}

interface RequestRecord {
  method: string
  url: URL
  headers: Headers
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function queryEntries(params: URLSearchParams): Array<[string, string]> {
  return [...params.entries()].sort(([left], [right]) => left.localeCompare(right))
}

class XApiServer {
  readonly requests: RequestRecord[] = []
  readonly failures: string[] = []
  readonly server: Bun.Server<undefined>
  responseCount = 0
  private readonly expected: ExpectedRequest[] = []
  private readonly requestWaiters: Array<{ count: number; resolve(): void }> = []
  private readonly responseWaiters: Array<{ count: number; resolve(): void }> = []

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    })
  }

  get baseUrl(): string {
    return this.server.url.origin
  }

  expectUser(token: string, reply: JsonReply | (() => JsonReply | Promise<JsonReply>)): void {
    this.expected.push({
      label: "authenticated user",
      token,
      pathname: "/2/users/me",
      query: { "user.fields": "id,name,profile_image_url,username" },
      reply: typeof reply === "function" ? reply : () => reply,
    })
  }

  expectTimeline(
    token: string,
    userId: string,
    reply: JsonReply | (() => JsonReply | Promise<JsonReply>),
    paginationToken?: string,
  ): void {
    this.expected.push({
      label: paginationToken ? "paginated timeline" : "timeline",
      token,
      pathname: `/2/users/${encodeURIComponent(userId)}/timelines/reverse_chronological`,
      query: { ...TIMELINE_QUERY, ...(paginationToken ? { pagination_token: paginationToken } : {}) },
      reply: typeof reply === "function" ? reply : () => reply,
    })
  }

  async waitForRequestCount(count: number): Promise<void> {
    if (this.requests.length >= count) return
    await new Promise<void>((resolve) => this.requestWaiters.push({ count, resolve }))
  }

  async waitForResponseCount(count: number): Promise<void> {
    if (this.responseCount >= count) return
    await new Promise<void>((resolve) => this.responseWaiters.push({ count, resolve }))
  }

  assertDone(): void {
    expect(this.failures).toEqual([])
    expect(this.expected.map((request) => request.label)).toEqual([])
  }

  async stop(): Promise<void> {
    await this.server.stop(true)
  }

  private async handle(request: Request): Promise<Response> {
    const record = { method: request.method, url: new URL(request.url), headers: request.headers }
    this.requests.push(record)
    for (const waiter of this.requestWaiters.splice(0)) {
      if (this.requests.length >= waiter.count) waiter.resolve()
      else this.requestWaiters.push(waiter)
    }

    const expected = this.expected.shift()
    if (!expected) {
      this.failures.push(`Unexpected ${request.method} ${record.url.pathname}${record.url.search}`)
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    }

    if (request.method !== "GET") this.failures.push(`${expected.label}: expected GET, received ${request.method}`)
    if (record.url.pathname !== expected.pathname) {
      this.failures.push(`${expected.label}: expected path ${expected.pathname}, received ${record.url.pathname}`)
    }
    const expectedQuery = queryEntries(new URLSearchParams(expected.query))
    const actualQuery = queryEntries(record.url.searchParams)
    if (JSON.stringify(actualQuery) !== JSON.stringify(expectedQuery)) {
      this.failures.push(
        `${expected.label}: expected query ${JSON.stringify(expectedQuery)}, received ${JSON.stringify(actualQuery)}`,
      )
    }
    const expectedHeaders = {
      accept: "application/json",
      authorization: `Bearer ${expected.token}`,
      "user-agent": "OpenTUI-X-Demo/1.0",
    }
    for (const [name, value] of Object.entries(expectedHeaders)) {
      if (request.headers.get(name) !== value) {
        this.failures.push(`${expected.label}: expected ${name}=${value}, received ${request.headers.get(name)}`)
      }
    }

    const reply = await expected.reply()
    this.responseCount += 1
    for (const waiter of this.responseWaiters.splice(0)) {
      if (this.responseCount >= waiter.count) waiter.resolve()
      else this.responseWaiters.push(waiter)
    }
    return Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers })
  }
}

interface AppHarness {
  api: XApiServer
  setup: TestRendererSetup
  rendererErrors: unknown[]
  unhandled: unknown[]
  close(): Promise<void>
}

async function createApp(height: number = 30): Promise<AppHarness> {
  const configHome = mkdtempSync(join(process.cwd(), ".xtui-app-test-"))
  const originalAppData = process.env.APPDATA
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
  const restoreEnvironment = () => {
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }
  process.env.APPDATA = configHome
  process.env.XDG_CONFIG_HOME = configHome

  let api: XApiServer | null = null
  let setup: TestRendererSetup | null = null
  try {
    api = new XApiServer()
    setup = await createTestRenderer({ width: 100, height, kittyKeyboard: true })
    const rendererErrors: unknown[] = []
    const unhandled: unknown[] = []
    const onRenderError = (event: CliRendererErrorEvent) => rendererErrors.push(event.error)
    const onHandlerError = (event: CliRendererHandlerErrorEvent) => rendererErrors.push(event.error)
    const onUnhandledRejection = (error: unknown) => unhandled.push(error)
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, onRenderError)
    setup.renderer.on(CliRenderEvents.HANDLER_ERROR, onHandlerError)
    process.on("unhandledRejection", onUnhandledRejection)
    run(setup.renderer, { detectedBrowsers: [], xApiBaseUrl: api.baseUrl })
    const activeApi = api
    const activeSetup = setup

    return {
      api: activeApi,
      setup: activeSetup,
      rendererErrors,
      unhandled,
      async close() {
        process.off("unhandledRejection", onUnhandledRejection)
        if (!activeSetup.renderer.isDestroyed) activeSetup.renderer.destroy()
        destroy()
        await activeApi.stop()
        restoreEnvironment()
        rmSync(configHome, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (setup && !setup.renderer.isDestroyed) setup.renderer.destroy()
    destroy()
    if (api) await api.stop()
    restoreEnvironment()
    rmSync(configHome, { recursive: true, force: true })
    throw error
  }
}

async function loginOfficial(app: AppHarness, token: string = "test-token"): Promise<void> {
  app.setup.mockInput.pressEnter()
  await app.setup.waitForFrame((frame) => frame.includes("OFFICIAL X API"))
  expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-official-token-input")
  await app.setup.mockInput.typeText(token)
  app.setup.mockInput.pressEnter()
}

async function waitForApiFrame(
  app: AppHarness,
  requestCount: number,
  predicate: (frame: string) => boolean,
): Promise<string> {
  await app.api.waitForRequestCount(requestCount)
  await app.api.waitForResponseCount(requestCount)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await app.setup.renderOnce()
    const frame = app.setup.captureCharFrame()
    if (predicate(frame)) return frame
  }
  throw new Error(`Timed out waiting for API-driven frame:\n${app.setup.captureCharFrame()}`)
}

function getCard(app: AppHarness, id: string): BoxRenderable {
  const card = app.setup.renderer.root.findDescendantById(`x-post-${id}`)
  expect(card).toBeInstanceOf(BoxRenderable)
  return card as BoxRenderable
}

function countPostCards(renderable: Renderable): number {
  let count = /^x-post-\d+$/.test(renderable.id) ? 1 : 0
  for (const child of renderable.getChildren()) {
    if ("getChildren" in child) count += countPostCards(child as Renderable)
  }
  return count
}

function expectHealthy(app: AppHarness): void {
  expect(app.rendererErrors).toEqual([])
  expect(app.unhandled).toEqual([])
}

function posts(start: number, count: number): Array<{ id: string; text: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: String(start + index), text: `Post ${start + index}` }))
}

describe("xtui application", () => {
  test("runs official authentication, rendering, focus, and feed commands end to end", async () => {
    const app = await createApp(36)
    app.api.expectUser("test-token", {
      body: { data: { id: "42", name: "Signed In User", username: "signed_in" } },
    })
    app.api.expectTimeline("test-token", "42", {
      body: {
        data: [
          {
            id: "1001",
            text: "Main body @bob https://t.co/quoted",
            author_id: "7",
            referenced_tweets: [{ id: "1000", type: "quoted" }],
            entities: {
              urls: [
                {
                  url: "https://t.co/quoted",
                  expanded_url: "https://x.com/bob/status/1000",
                  display_url: "x.com/bob/status/1000",
                },
              ],
            },
            public_metrics: { reply_count: 2, retweet_count: 1_200, like_count: 1_500_000 },
          },
          { id: "1002", text: "Second post", author_id: "7" },
        ],
        includes: {
          users: [
            { id: "7", name: "Alice", username: "alice" },
            { id: "8", name: "Bob", username: "bob" },
          ],
          tweets: [{ id: "1000", text: "Quoted body", author_id: "8" }],
        },
        meta: {},
      },
      headers: { "x-rate-limit-remaining": "99" },
    })

    try {
      const initialFrame = await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      expect(initialFrame).toContain("Official X API")
      expect(initialFrame).toContain("documented · recommended")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-connection-select")

      app.setup.mockInput.pressEnter()
      await app.setup.waitForFrame((frame) => frame.includes("tweet.read and users.read"))
      app.setup.mockInput.pressEnter()
      const requiredFrame = await app.setup.waitForFrame((frame) => frame.includes("TOKEN REQUIRED"))
      expect(requiredFrame).toContain("OAuth 2.0 user access token")
      expect(app.api.requests).toHaveLength(0)

      await app.setup.mockInput.typeText("Bearer test-token")
      await app.setup.waitForFrame((frame) => frame.includes("TOKEN ENTERED · 17 characters"))
      const tokenSpan = app.setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("Bearer test-token"))
      expect(tokenSpan).toBeDefined()
      expect(tokenSpan!.attributes & TextAttributes.HIDDEN).toBe(TextAttributes.HIDDEN)
      app.setup.mockInput.pressEnter()

      const frame = await waitForApiFrame(app, 2, (value) => value.includes("Main body @bob"))
      expect(frame).toContain("Alice @alice")
      expect(frame).toContain("Bob @bob")
      expect(frame).toContain("Quoted body")
      expect(frame).toContain("↩ 2")
      expect(frame).toContain("♥ 1.5M")
      expect(frame).toContain("↻ 1.2K")
      expect(frame).toContain("2 Following posts · X API v2 · read-only · 99 API requests remaining")
      expect(frame).not.toContain("https://t.co/quoted")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")

      expect(getCard(app, "1001").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      expect(getCard(app, "1002").backgroundColor.toInts()).toEqual([8, 8, 8, 255])
      app.setup.mockInput.pressKey("j")
      await app.setup.renderOnce()
      expect(getCard(app, "1001").backgroundColor.toInts()).toEqual([8, 8, 8, 255])
      expect(getCard(app, "1002").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      app.setup.mockInput.pressKey("k")
      expect(getCard(app, "1001").backgroundColor.toInts()).toEqual([22, 24, 28, 255])

      app.setup.mockInput.pressTab()
      const streamFrame = await app.setup.waitForFrame((value) =>
        value.includes("The documented X API exposes Following only"),
      )
      expect(streamFrame).toContain("For You requires browser-session mode")
      expect(app.api.requests).toHaveLength(2)

      app.setup.mockInput.pressKey("a")
      const sessionFrame = await app.setup.waitForFrame((value) => value.includes("CONNECT X"))
      expect(sessionFrame).toContain("Official X API")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-connection-select")
      app.setup.mockInput.pressEscape()
      const restoredFrame = await app.setup.waitForFrame(
        (value) => value.includes("Main body @bob") && !value.includes("CONNECT X"),
      )
      expect(restoredFrame).not.toContain("CONNECT X")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("expands and collapses the selected long post", async () => {
    const app = await createApp(18)
    const suffix = "EXPANDED"
    app.api.expectUser("long-token", { body: { data: { id: "42", name: "Reader", username: "reader" } } })
    app.api.expectTimeline("long-token", "42", {
      body: { data: [{ id: "2001", text: `${"a".repeat(280)}${suffix}` }], meta: {} },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "long-token")
      const collapsed = await waitForApiFrame(app, 2, (frame) => frame.includes("[E] Show More"))
      expect(collapsed).not.toContain(suffix)

      app.setup.mockInput.pressKey("e")
      const expanded = await app.setup.waitForFrame((frame) => frame.includes(suffix))
      expect(expanded).toContain("[E] Show Less")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")

      app.setup.mockInput.pressKey("e")
      const collapsedAgain = await app.setup.waitForFrame(
        (frame) => frame.includes("[E] Show More") && !frame.includes(suffix),
      )
      expect(collapsedAgain).not.toContain(suffix)

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("paginates near the end, deduplicates posts, and stops at the final page", async () => {
    const app = await createApp(12)
    const pageRequested = deferred<void>()
    const releasePage = deferred<void>()
    app.api.expectUser("page-token", { body: { data: { id: "42", name: "Reader", username: "reader" } } })
    app.api.expectTimeline("page-token", "42", {
      body: { data: posts(1, 20), meta: { next_token: "next-page" } },
    })
    app.api.expectTimeline(
      "page-token",
      "42",
      async () => {
        pageRequested.resolve()
        await releasePage.promise
        return {
          body: {
            data: [
              { id: "20", text: "Duplicate Post 20" },
              { id: "21", text: "Post 21" },
            ],
            meta: {},
          },
        }
      },
      "next-page",
    )

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "page-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Post 1"))

      for (let index = 0; index < 15; index += 1) app.setup.mockInput.pressKey("j")
      await pageRequested.promise
      const loadingFrame = await app.setup.waitForFrame((frame) => frame.includes("LOADING MORE POSTS"))
      expect(loadingFrame).toContain("Loading more posts...")

      releasePage.resolve()
      const completedFrame = await waitForApiFrame(app, 3, (frame) => frame.includes("21 posts · end of timeline"))
      expect(completedFrame).not.toContain("LOADING MORE POSTS")
      expect(app.setup.renderer.root.findDescendantById("x-post-21")).toBeDefined()
      expect(countPostCards(app.setup.renderer.root)).toBe(21)

      for (let index = 0; index < 10; index += 1) app.setup.mockInput.pressKey("j")
      await app.setup.renderOnce()
      expect(app.api.requests).toHaveLength(3)

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      releasePage.resolve()
      await app.close()
    }
  })

  test("shows an API error and recovers through the session flow", async () => {
    const app = await createApp(24)
    app.api.expectUser("expired-token", {
      status: 403,
      body: { errors: [{ detail: "Missing users.read scope" }] },
    })
    app.api.expectUser("new-token", { body: { data: { id: "84", name: "Recovered", username: "recovered" } } })
    app.api.expectTimeline("new-token", "84", {
      body: { data: [{ id: "3001", text: "Recovered timeline" }], meta: {} },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "expired-token")
      const errorFrame = await waitForApiFrame(app, 1, (frame) => frame.includes("CAN'T LOAD X"))
      expect(errorFrame).toContain("X API HTTP 403: Missing users.read scope")
      expect(errorFrame).toContain("Verify this is a user-context OAuth token")
      expect(errorFrame).toContain("Connection failed · A replace credentials")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")

      app.setup.mockInput.pressKey("a")
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "new-token")
      const recoveredFrame = await waitForApiFrame(app, 3, (frame) => frame.includes("Recovered timeline"))
      expect(recoveredFrame).not.toContain("CAN'T LOAD X")
      expect(app.setup.renderer.root.findDescendantById("x-post-3001")).toBeDefined()

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("renders an empty timeline and enforces the refresh cooldown", async () => {
    const app = await createApp(20)
    app.api.expectUser("empty-token", { body: { data: { id: "42", name: "Reader", username: "reader" } } })
    app.api.expectTimeline("empty-token", "42", { body: { data: [], meta: {} } })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "empty-token")
      const emptyFrame = await waitForApiFrame(app, 2, (frame) => frame.includes("YOUR HOME IS QUIET"))
      expect(emptyFrame).toContain("X returned no posts. R refresh.")
      expect(emptyFrame).toContain("0 Following posts · X API v2 · read-only")

      app.setup.mockInput.pressKey("r")
      const cooldownFrame = await app.setup.waitForFrame((frame) => frame.includes("Refresh cooldown"))
      expect(cooldownFrame).toContain("remaining")
      expect(app.api.requests).toHaveLength(2)

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("does not start the timeline request after quitting during user lookup", async () => {
    const app = await createApp(12)
    const userRequested = deferred<void>()
    const releaseUser = deferred<void>()
    app.api.expectUser("lookup-token", async () => {
      userRequested.resolve()
      await releaseUser.promise
      return { body: { data: { id: "42", name: "Reader", username: "reader" } } }
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "lookup-token")
      await userRequested.promise

      app.setup.mockInput.pressKey("q")
      expect(app.setup.renderer.isDestroyed).toBe(true)
      releaseUser.resolve()
      await app.api.waitForResponseCount(1)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      expect(app.api.requests).toHaveLength(1)
      app.api.assertDone()
      expectHealthy(app)
    } finally {
      releaseUser.resolve()
      await app.close()
    }
  })

  test("ignores a pagination response released after quitting", async () => {
    const app = await createApp(12)
    const pageRequested = deferred<void>()
    const releasePage = deferred<void>()
    app.api.expectUser("exit-token", { body: { data: { id: "42", name: "Reader", username: "reader" } } })
    app.api.expectTimeline("exit-token", "42", {
      body: { data: posts(1, 20), meta: { next_token: "next-page" } },
    })
    app.api.expectTimeline(
      "exit-token",
      "42",
      async () => {
        pageRequested.resolve()
        await releasePage.promise
        return { body: { data: [{ id: "21", text: "Late post" }], meta: {} } }
      },
      "next-page",
    )

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "exit-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Post 1"))
      for (let index = 0; index < 15; index += 1) app.setup.mockInput.pressKey("j")
      await pageRequested.promise

      app.setup.mockInput.pressKey("q")
      expect(app.setup.renderer.isDestroyed).toBe(true)
      releasePage.resolve()
      await app.api.waitForResponseCount(3)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      releasePage.resolve()
      await app.close()
    }
  })
})
