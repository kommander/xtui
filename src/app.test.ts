import { describe, expect, test } from "bun:test"
import {
  BoxRenderable,
  CliRenderEvents,
  ConsolePosition,
  ImageRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRendererErrorEvent,
  type CliRendererHandlerErrorEvent,
  type Renderable,
} from "@opentui/core"
import { createTestRenderer, MouseButtons, TestRecorder, type TestRendererSetup } from "@opentui/core/testing"
import { TwitterClient, type TweetData } from "@steipete/bird"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_KEYBINDINGS } from "./config.js"
import { destroy, run, type XDemoRunOptions } from "./index.js"

const TIMELINE_QUERY = {
  max_results: "20",
  "tweet.fields": "attachments,author_id,created_at,entities,note_tweet,public_metrics,referenced_tweets",
  expansions:
    "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id",
  "user.fields": "id,name,profile_image_url,username",
  "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width",
} as const
const COMMENTS_QUERY = {
  sort_order: "recency",
  max_results: "100",
  "tweet.fields": "attachments,author_id,created_at,entities,note_tweet,public_metrics,referenced_tweets",
  expansions:
    "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id",
  "user.fields": "id,name,profile_image_url,username",
  "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width",
} as const
const RED_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg=="
const BLUE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const BROKEN_IMAGE_DATA_URL = "data:text/plain;base64,bm90IGFuIGltYWdl"

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

  expectComments(
    token: string,
    tweetId: string,
    reply: JsonReply | (() => JsonReply | Promise<JsonReply>),
    nextToken?: string,
  ): void {
    this.expected.push({
      label: nextToken ? "paginated comments" : "comments",
      token,
      pathname: "/2/tweets/search/recent",
      query: {
        query: `in_reply_to_tweet_id:${tweetId}`,
        ...COMMENTS_QUERY,
        ...(nextToken ? { next_token: nextToken } : {}),
      },
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

async function createApp(height: number = 30, options: XDemoRunOptions = {}, width: number = 100): Promise<AppHarness> {
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
    setup = await createTestRenderer({
      width,
      height,
      kittyKeyboard: true,
      exitOnCtrlC: false,
      consoleMode: "console-overlay",
      consoleOptions: { position: ConsolePosition.TOP },
    })
    const rendererErrors: unknown[] = []
    const unhandled: unknown[] = []
    const onRenderError = (event: CliRendererErrorEvent) => rendererErrors.push(event.error)
    const onHandlerError = (event: CliRendererHandlerErrorEvent) => rendererErrors.push(event.error)
    const onUnhandledRejection = (error: unknown) => unhandled.push(error)
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, onRenderError)
    setup.renderer.on(CliRenderEvents.HANDLER_ERROR, onHandlerError)
    process.on("unhandledRejection", onUnhandledRejection)
    run(setup.renderer, {
      ...options,
      detectedBrowsers: options.detectedBrowsers ?? [],
      xApiBaseUrl: options.xApiBaseUrl ?? api.baseUrl,
    })
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

async function loginCookie(app: AppHarness, session: string = "auth_token=test-auth; ct0=test-csrf"): Promise<void> {
  await clickSelectOption(app, "x-connection-select", 1)
  await app.setup.waitForFrame((frame) => frame.includes("ACCOUNT RISK"))
  await clickSelectOption(app, "x-cookie-risk-select", 1)
  await app.setup.waitForFrame((frame) => frame.includes("Use a session token or your browser login"))
  await clickRenderable(app, "x-auth-input-box")
  await app.setup.mockInput.typeText(session)
  await clickRenderable(app, "x-auth-hint-submit")
}

async function waitForApiFrame(
  app: AppHarness,
  requestCount: number,
  predicate: (frame: string) => boolean,
): Promise<string> {
  await app.api.waitForRequestCount(requestCount)
  await app.api.waitForResponseCount(requestCount)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await Bun.sleep(1)
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

function getScrollBox(app: AppHarness, id: string): ScrollBoxRenderable {
  const scrollBox = app.setup.renderer.root.findDescendantById(id)
  expect(scrollBox).toBeInstanceOf(ScrollBoxRenderable)
  return scrollBox as ScrollBoxRenderable
}

function getImage(app: AppHarness, id: string): ImageRenderable {
  const image = app.setup.renderer.root.findDescendantById(id)
  expect(image).toBeInstanceOf(ImageRenderable)
  return image as ImageRenderable
}

async function clickRenderable(app: AppHarness, id: string, clipId?: string): Promise<void> {
  await app.setup.renderOnce()
  const target = app.setup.renderer.root.findDescendantById(id)
  expect(target).toBeDefined()
  const clip = clipId ? app.setup.renderer.root.findDescendantById(clipId) : undefined
  if (clipId) expect(clip).toBeDefined()
  const left = Math.max(target!.screenX, clip?.screenX ?? target!.screenX)
  const top = Math.max(target!.screenY, clip?.screenY ?? target!.screenY)
  const right = Math.min(
    target!.screenX + target!.width,
    clip ? clip.screenX + clip.width : target!.screenX + target!.width,
  )
  const bottom = Math.min(
    target!.screenY + target!.height,
    clip ? clip.screenY + clip.height : target!.screenY + target!.height,
  )
  expect(right).toBeGreaterThan(left)
  expect(bottom).toBeGreaterThan(top)
  await app.setup.mockMouse.click(
    Math.floor((left + right - 1) / 2),
    Math.floor((top + bottom - 1) / 2),
    MouseButtons.LEFT,
    {
      delayMs: 0,
    },
  )
  await Bun.sleep(0)
  if (!app.setup.renderer.isDestroyed) await app.setup.renderOnce()
}

async function clickSelectOption(app: AppHarness, id: string, index: number): Promise<void> {
  await app.setup.renderOnce()
  const select = app.setup.renderer.root.findDescendantById(id)
  expect(select).toBeDefined()
  await app.setup.mockMouse.click(select!.screenX + 1, select!.screenY + index * 2, MouseButtons.LEFT, { delayMs: 0 })
  await Bun.sleep(0)
  if (!app.setup.renderer.isDestroyed) await app.setup.renderOnce()
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
  test("uses Ctrl+C as the only exit key", async () => {
    const app = await createApp(18)

    try {
      const frame = await app.setup.waitForFrame((value) => value.includes("CONNECT X"))
      expect(frame).toContain("CTRL+C quit")
      expect(frame).not.toContain("ESC back")
      expect(getScrollBox(app, "x-feed").verticalScrollBar.visible).toBe(false)
      expect(getScrollBox(app, "x-comments-feed").verticalScrollBar.visible).toBe(false)

      app.setup.mockInput.pressKey("q")
      app.setup.mockInput.pressEscape()
      expect(app.setup.renderer.isDestroyed).toBe(false)
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-connection-select")

      app.setup.mockInput.pressCtrlC()
      expect(app.setup.renderer.isDestroyed).toBe(true)
      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("applies configured keybindings and scrollbars", async () => {
    const app = await createApp(18, {
      config: {
        scrollbar: true,
        keybindings: {
          ...DEFAULT_KEYBINDINGS,
          "x.feed.next": "n",
          "x.feed.previous": "ctrl+",
          "app.quit": "q",
        },
      },
    })
    app.api.expectUser("config-q`-token", { body: { data: { id: "42", name: "Reader", username: "reader" } } })
    app.api.expectTimeline("config-q`-token", "42", {
      body: {
        data: [
          { id: "101", text: "First configured post" },
          { id: "102", text: "Second configured post" },
        ],
      },
    })

    try {
      expect((app.setup.renderer.console as unknown as { isVisible: boolean }).isVisible).toBe(true)
      app.setup.mockInput.pressKey("`")
      expect((app.setup.renderer.console as unknown as { isVisible: boolean }).isVisible).toBe(false)
      await loginOfficial(app, "config-q`-token")
      const frame = await waitForApiFrame(app, 2, (value) => value.includes("Second configured post"))
      expect(frame).toContain("N/K select")
      expect(getScrollBox(app, "x-feed").verticalScrollBar.visible).toBe(true)
      expect(getScrollBox(app, "x-comments-feed").verticalScrollBar.visible).toBe(true)

      app.setup.mockInput.pressKey("j")
      await app.setup.renderOnce()
      expect(getCard(app, "101").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      app.setup.mockInput.pressKey("n")
      await app.setup.renderOnce()
      expect(getCard(app, "102").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      app.setup.mockInput.pressKey("k")
      await app.setup.renderOnce()
      expect(getCard(app, "101").backgroundColor.toInts()).toEqual([22, 24, 28, 255])

      app.api.assertDone()
      expectHealthy(app)
      app.setup.mockInput.pressKey("q")
      expect(app.setup.renderer.isDestroyed).toBe(true)
    } finally {
      await app.close()
    }
  })

  test("supports mouse selection and submission in the official connection flow", async () => {
    const app = await createApp(24)
    app.api.expectUser("mouse-token", {
      body: { data: { id: "42", name: "Mouse User", username: "mouse_user" } },
    })
    app.api.expectTimeline("mouse-token", "42", {
      body: { data: [{ id: "7001", text: "Mouse authenticated timeline" }], meta: {} },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await clickSelectOption(app, "x-connection-select", 0)
      await app.setup.waitForFrame((frame) => frame.includes("OFFICIAL X API"))
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-official-token-input")

      await clickRenderable(app, "x-official-token-input-box")
      await app.setup.mockInput.typeText("mouse-token")
      await app.setup.waitForFrame((frame) => frame.includes("TOKEN · 11 CHARS"))
      await clickRenderable(app, "x-official-token-hint-submit")
      const frame = await waitForApiFrame(app, 2, (value) => value.includes("Mouse authenticated timeline"))
      expect(frame).toContain("1 Following posts · X API v2 · read-only")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("keeps modal actions and mouse controls visible in a narrow terminal", async () => {
    const app = await createApp(24, {}, 40)
    app.api.expectUser("narrow-token", {
      body: { data: { id: "42", name: "Narrow User", username: "narrow_user" } },
    })
    app.api.expectTimeline("narrow-token", "42", {
      body: { data: [{ id: "7201", text: "Narrow timeline" }], meta: {} },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await clickSelectOption(app, "x-connection-select", 0)
      await app.setup.waitForFrame((frame) => frame.includes("OFFICIAL X API"))
      await clickRenderable(app, "x-official-token-hint-submit")
      const errorFrame = await app.setup.waitForFrame((frame) => frame.includes("TOKEN") && frame.includes("REQUIRED"))
      expect(errorFrame).toContain("back")
      expect(errorFrame).toContain("quit")

      await app.setup.mockInput.typeText("narrow-token")
      await clickRenderable(app, "x-official-token-hint-submit")
      const timelineFrame = await waitForApiFrame(app, 2, (frame) => frame.includes("Narrow timeline"))
      expect(timelineFrame).toContain("comments image refresh session logs")
      expect(timelineFrame).not.toContain("CTRL+C quit")
      expect(app.setup.renderer.root.findDescendantById("x-footer-quit")).toBeUndefined()

      app.setup.renderer.resize(30, 12)
      await app.setup.renderOnce()
      const extraNarrowFrame = app.setup.captureCharFrame()
      expect(extraNarrowFrame).toContain("comments refresh session logs")
      expect(app.setup.renderer.root.findDescendantById("x-footer-image")).toBeUndefined()

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

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
      await app.setup.waitForFrame((frame) => frame.includes("TOKEN · 17 CHARS"))
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
      app.setup.mockInput.pressKey("i")
      await app.setup.renderOnce()
      expect(app.setup.renderer.root.findDescendantById("x-image-view")?.visible).toBe(false)
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

  test("normalizes documented API retweets to the original post", async () => {
    const openedUrls: string[] = []
    const app = await createApp(20, {
      async openUrl(url) {
        openedUrls.push(url)
      },
    })
    app.api.expectUser("official-retweet-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("official-retweet-token", "42", {
      body: {
        data: [
          {
            id: "8001",
            text: "RT @original: truncated…",
            author_id: "7",
            referenced_tweets: [{ id: "8000", type: "retweeted" }],
            public_metrics: { reply_count: 0, retweet_count: 4, like_count: 0 },
          },
        ],
        includes: {
          users: [
            { id: "7", name: "Reposter", username: "reposter" },
            { id: "8", name: "Original", username: "original" },
          ],
          tweets: [
            {
              id: "8000",
              text: "Complete documented API orig…",
              note_tweet: { text: "Complete documented API original" },
              author_id: "8",
              public_metrics: { reply_count: 2, quote_count: 3, retweet_count: 5, like_count: 7 },
            },
          ],
        },
        meta: {},
      },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "official-retweet-token")
      const frame = await waitForApiFrame(app, 2, (value) => value.includes("Reposter reposted"))
      expect(frame).toContain("Original @original")
      expect(frame).toContain("Complete documented API original")
      expect(frame).not.toContain("orig…")
      expect(frame).not.toContain("truncated…")
      expect(frame).toContain("↩ 2")
      expect(frame).toContain("♥ 7")
      expect(frame).toContain("↻ 5")
      expect(getCard(app, "8001")).toBeDefined()

      app.setup.mockInput.pressKey("o")
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(openedUrls).toEqual(["https://x.com/original/status/8000"])

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("supports mouse actions across the timeline and comments views", async () => {
    const openedUrls: string[] = []
    const app = await createApp(36, {
      async openUrl(url) {
        openedUrls.push(url)
      },
    })
    app.api.expectUser("mouse-actions-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("mouse-actions-token", "42", {
      body: {
        data: [
          { id: "7101", text: "First mouse post" },
          { id: "7102", text: `${"b".repeat(280)}TAIL` },
        ],
        meta: {},
      },
    })
    app.api.expectComments("mouse-actions-token", "7102", { body: { data: [], meta: {} } })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "mouse-actions-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("First mouse post"))

      await clickRenderable(app, "x-post-7102")
      expect(openedUrls).toEqual([])
      expect(getCard(app, "7101").backgroundColor.toInts()).toEqual([8, 8, 8, 255])
      expect(getCard(app, "7102").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      await clickRenderable(app, "x-footer-open")
      expect(openedUrls).toEqual([])

      await clickRenderable(app, "x-post-toggle-7102")
      expect(openedUrls).toEqual([])
      const expanded = await app.setup.waitForFrame((frame) => frame.includes("TAIL"))
      expect(expanded).toContain("[E] Show Less")

      await clickRenderable(app, "x-header-home")
      await app.setup.waitForFrame((frame) => frame.includes("The documented X API exposes Following only"))
      expect(app.api.requests).toHaveLength(2)

      await clickRenderable(app, "x-footer-refresh")
      await app.setup.waitForFrame((frame) => frame.includes("Refresh cooldown"))
      expect(app.api.requests).toHaveLength(2)

      await clickRenderable(app, "x-post-replies-1")
      const commentsFrame = await waitForApiFrame(app, 3, (frame) => frame.includes("NO RECENT DIRECT REPLIES FOUND"))
      expect(commentsFrame).toContain("SELECTED POST")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-comments-feed")

      await clickRenderable(app, "x-header-action")
      await app.setup.waitForFrame((frame) => frame.includes("First mouse post") && !frame.includes("SELECTED POST"))
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")
      expect(getCard(app, "7102").backgroundColor.toInts()).toEqual([22, 24, 28, 255])

      await clickRenderable(app, "x-footer-session")
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-connection-select")
      await clickRenderable(app, "x-connection-hint-back")
      await app.setup.waitForFrame((frame) => frame.includes("First mouse post") && !frame.includes("CONNECT X"))

      await clickRenderable(app, "x-footer-logs")
      expect(app.setup.renderer.console.visible).toBe(true)
      await clickRenderable(app, "x-footer-logs")
      expect(app.setup.renderer.console.visible).toBe(false)

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
      const loadingFrame = await app.setup.waitForFrame((frame) => frame.includes("Loading more Following posts"))
      expect(loadingFrame).toContain("Loading more Following posts...")

      releasePage.resolve()
      const completedFrame = await waitForApiFrame(app, 3, (frame) => frame.includes("21 posts · end of timeline"))
      expect(completedFrame).not.toContain("Loading more Following posts")
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

  test("stops automatic pagination after a load-more error", async () => {
    const app = await createApp(12)
    app.api.expectUser("page-error-token", { body: { data: { id: "42", name: "Reader", username: "reader" } } })
    app.api.expectTimeline("page-error-token", "42", {
      body: { data: posts(1, 20), meta: { next_token: "broken-page" } },
    })
    app.api.expectTimeline(
      "page-error-token",
      "42",
      { status: 500, body: { errors: [{ detail: "Page unavailable" }] } },
      "broken-page",
    )

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "page-error-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Post 1"))
      for (let index = 0; index < 15; index += 1) app.setup.mockInput.pressKey("j")
      const errorFrame = await waitForApiFrame(app, 3, (frame) => frame.includes("Could not load more posts"))
      expect(errorFrame).toContain("Page unavailable")
      expect(app.setup.renderer.root.findDescendantById("x-activity-spinner")?.visible).toBe(false)

      for (let index = 0; index < 10; index += 1) await app.setup.renderOnce()
      expect(app.api.requests).toHaveLength(3)
      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("scrolls the timeline with the mouse without changing selection", async () => {
    const app = await createApp(12)
    app.api.expectUser("mouse-scroll-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("mouse-scroll-token", "42", {
      body: { data: posts(1, 20), meta: { next_token: "mouse-next" } },
    })
    app.api.expectTimeline(
      "mouse-scroll-token",
      "42",
      { body: { data: [{ id: "21", text: "Post 21" }], meta: {} } },
      "mouse-next",
    )

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "mouse-scroll-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Post 1"))
      const feed = getScrollBox(app, "x-feed")
      const x = feed.viewport.screenX + Math.floor(feed.viewport.width / 2)
      const y = feed.viewport.screenY + Math.floor(feed.viewport.height / 2)
      const initialScrollTop = feed.scrollTop

      for (let index = 0; index < feed.scrollHeight && app.api.requests.length < 3; index += 1) {
        await app.setup.mockMouse.scroll(x, y, "down")
        await app.setup.renderOnce()
      }
      expect(feed.scrollTop).toBeGreaterThan(initialScrollTop)
      expect(getCard(app, "1").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      await waitForApiFrame(app, 3, (frame) => frame.includes("21 posts · end of timeline"))
      expect(app.setup.renderer.root.findDescendantById("x-post-21")).toBeDefined()
      const scrolledTop = feed.scrollTop

      for (let index = 0; index < 3; index += 1) {
        await app.setup.mockMouse.scroll(x, y, "up")
        await app.setup.renderOnce()
      }
      expect(feed.scrollTop).toBeLessThan(scrolledTop)
      expect(getCard(app, "1").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      expect(app.api.requests).toHaveLength(3)

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("opens, navigates, zooms, pans, and closes the image view", async () => {
    const app = await createApp(50)
    app.api.expectUser("image-view-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("image-view-token", "42", {
      body: {
        data: [
          {
            id: "7201",
            text: "Two image post",
            attachments: { media_keys: ["photo-1", "photo-2", "video-1"] },
            public_metrics: { reply_count: 7, quote_count: 3, retweet_count: 5, like_count: 9 },
          },
        ],
        includes: {
          media: [
            {
              media_key: "photo-1",
              type: "photo",
              url: RED_PNG_DATA_URL,
              preview_image_url: BLUE_PNG_DATA_URL,
              width: 1,
              height: 1,
            },
            {
              media_key: "photo-2",
              type: "photo",
              url: BROKEN_IMAGE_DATA_URL,
              preview_image_url: BLUE_PNG_DATA_URL,
              width: 1,
              height: 1,
            },
            { media_key: "video-1", type: "video", preview_image_url: RED_PNG_DATA_URL, width: 1, height: 1 },
          ],
        },
        meta: {},
      },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "image-view-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Two image post"))
      await app.setup.flush({ maxPasses: 50 })

      app.setup.mockInput.pressKey("i")
      const firstFrame = await app.setup.waitForFrame((frame) => frame.includes("IMAGE · 1/2 · 100%"))
      expect(firstFrame).toContain("7 replies   3 quotes   9 likes")
      expect(firstFrame).not.toContain("FOLLOWING  TAB SWITCH")
      const overlay = app.setup.renderer.root.findDescendantById("x-image-view")
      const appRoot = app.setup.renderer.root.findDescendantById("x-demo-root")
      const image = getImage(app, "x-image-view-image")
      expect(overlay?.visible).toBe(true)
      expect(appRoot?.visible).toBe(false)
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-image-view")
      expect(image.source).toBe(RED_PNG_DATA_URL)
      await image.loadPromise
      await app.setup.flush({ maxPasses: 50 })

      app.setup.renderer.resize(80, 30)
      await app.setup.renderOnce()
      const resizedViewport = app.setup.renderer.root.findDescendantById("x-image-viewport")
      expect(resizedViewport?.width).toBe(80)
      expect(resizedViewport?.height).toBe(28)
      expect(image.width).toBe(80)
      app.setup.renderer.resize(100, 50)
      await app.setup.renderOnce()

      const fittedWidth = image.width
      app.setup.mockInput.pressKey("+")
      await app.setup.renderOnce()
      expect(image.width).toBeGreaterThan(fittedWidth)
      app.setup.mockInput.pressKey("-")
      await app.setup.renderOnce()
      expect(image.width).toBe(fittedWidth)

      for (let step = 0; step < 12; step += 1) app.setup.mockInput.pressKey("+")
      await app.setup.renderOnce()
      const centeredLeft = Number(image.left)
      const centeredTop = Number(image.top)
      app.setup.mockInput.pressKey("h")
      app.setup.mockInput.pressKey("j")
      await app.setup.renderOnce()
      expect(Number(image.left)).toBeGreaterThan(centeredLeft)
      expect(Number(image.top)).toBeLessThan(centeredTop)

      app.setup.mockInput.pressKey("l")
      app.setup.mockInput.pressKey("k")
      await app.setup.renderOnce()
      expect(Number(image.left)).toBe(centeredLeft)
      expect(Number(image.top)).toBe(centeredTop)

      for (let step = 0; step < 100; step += 1) app.setup.mockInput.pressKey("h")
      for (let step = 0; step < 100; step += 1) app.setup.mockInput.pressKey("j")
      await app.setup.renderOnce()
      const viewport = app.setup.renderer.root.findDescendantById("x-image-viewport")!
      const fitted = image.getFittedSize(image.width, image.height)
      const fittedLeft = Number(image.left) + Math.floor((image.width - fitted.width) / 2)
      const fittedTop = Number(image.top) + Math.floor((image.height - fitted.height) / 2)
      expect(fittedLeft).toBe(0)
      expect(fittedTop + fitted.height).toBe(viewport.height)

      app.setup.mockInput.pressArrow("right")
      const secondFrame = await app.setup.waitForFrame((frame) => frame.includes("IMAGE · 2/2 · 100%"))
      expect(secondFrame).toContain("7 replies   3 quotes   9 likes")
      for (let pass = 0; pass < 20 && image.source !== BLUE_PNG_DATA_URL; pass += 1) {
        await Bun.sleep(0)
        await app.setup.renderOnce()
      }
      expect(image.source).toBe(BLUE_PNG_DATA_URL)
      expect(image.width).toBe(fittedWidth)

      app.setup.mockInput.pressArrow("left")
      await app.setup.waitForFrame((frame) => frame.includes("IMAGE · 1/2 · 100%"))
      expect(image.source).toBe(RED_PNG_DATA_URL)

      app.setup.mockInput.pressEscape()
      await app.setup.renderOnce()
      expect(overlay?.visible).toBe(false)
      expect(appRoot?.visible).toBe(true)
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")

      await clickRenderable(app, "x-post-media-image-0-1", "x-feed")
      await app.setup.waitForFrame((frame) => frame.includes("IMAGE · 2/2 · 100%"))
      for (let pass = 0; pass < 20 && image.source !== BLUE_PNG_DATA_URL; pass += 1) {
        await Bun.sleep(0)
        await app.setup.renderOnce()
      }
      expect(image.source).toBe(BLUE_PNG_DATA_URL)
      app.setup.mockInput.pressEscape()

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("opens the selected comment image and returns to comments", async () => {
    const app = await createApp(30)
    app.api.expectUser("comment-image-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("comment-image-token", "42", {
      body: { data: [{ id: "7251", text: "Root post" }], meta: {} },
    })
    app.api.expectComments("comment-image-token", "7251", {
      body: {
        data: [
          {
            id: "7252",
            text: "Reply with image",
            attachments: { media_keys: ["reply-photo"] },
            public_metrics: { reply_count: 2, quote_count: 4, retweet_count: 6, like_count: 8 },
          },
        ],
        includes: {
          media: [{ media_key: "reply-photo", type: "photo", url: BLUE_PNG_DATA_URL, width: 1, height: 1 }],
        },
        meta: {},
      },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "comment-image-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Root post"))
      app.setup.mockInput.pressKey("c")
      await waitForApiFrame(app, 3, (frame) => frame.includes("Reply with image"))

      app.setup.mockInput.pressKey("i")
      const imageFrame = await app.setup.waitForFrame((frame) => frame.includes("IMAGE · 100%"))
      expect(imageFrame).toContain("2 replies   4 quotes   8 likes")
      expect(getImage(app, "x-image-view-image").source).toBe(BLUE_PNG_DATA_URL)

      app.setup.mockInput.pressEscape()
      const commentsFrame = await app.setup.waitForFrame((frame) => frame.includes("Reply with image"))
      expect(commentsFrame).toContain("COMMENTS  DIRECT REPLIES")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-comments-feed")

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("does not open an image while comments are still preparing", async () => {
    const app = await createApp(30)
    const commentsRequested = deferred<void>()
    const releaseComments = deferred<void>()
    app.api.expectUser("image-race-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("image-race-token", "42", {
      body: {
        data: [{ id: "7261", text: "Root image", attachments: { media_keys: ["root-photo"] } }],
        includes: {
          media: [{ media_key: "root-photo", type: "photo", url: RED_PNG_DATA_URL, width: 1, height: 1 }],
        },
        meta: {},
      },
    })
    app.api.expectComments("image-race-token", "7261", async () => {
      commentsRequested.resolve()
      await releaseComments.promise
      return { body: { data: [], meta: {} } }
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "image-race-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Root image"))

      app.setup.mockInput.pressKey("c")
      app.setup.mockInput.pressKey("i")
      await app.setup.renderOnce()
      expect(app.setup.renderer.root.findDescendantById("x-image-view")?.visible).toBe(false)

      await commentsRequested.promise
      await app.setup.waitForFrame((frame) => frame.includes("X  COMMENTS"))
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-comments-feed")
      app.setup.mockInput.pressKey("i")
      await app.setup.waitForFrame((frame) => frame.includes("IMAGE · 100%"))
      expect(app.setup.renderer.root.findDescendantById("x-image-view")?.visible).toBe(true)
      app.setup.mockInput.pressEscape()

      releaseComments.resolve()
      await app.api.waitForResponseCount(3)
      app.api.assertDone()
      expectHealthy(app)
    } finally {
      releaseComments.resolve()
      await app.close()
    }
  })

  test("keeps exactly one row around media and quoted tweets", async () => {
    const app = await createApp(60)
    app.api.expectUser("spacing-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("spacing-token", "42", {
      body: {
        data: [
          {
            id: "7281",
            text: "Parent body",
            author_id: "7",
            attachments: { media_keys: ["parent-photo"] },
            referenced_tweets: [{ id: "7280", type: "quoted" }],
          },
        ],
        includes: {
          users: [
            { id: "7", name: "Parent", username: "parent" },
            { id: "8", name: "Quoted", username: "quoted" },
          ],
          tweets: [
            {
              id: "7280",
              text: "Quoted body",
              author_id: "8",
              attachments: { media_keys: ["quoted-photo"] },
            },
          ],
          media: [
            { media_key: "parent-photo", type: "photo", url: RED_PNG_DATA_URL, width: 1, height: 1 },
            { media_key: "quoted-photo", type: "photo", url: BLUE_PNG_DATA_URL, width: 1, height: 1 },
          ],
        },
        meta: {},
      },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "spacing-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Parent body"))
      await app.setup.flush({ maxPasses: 50 })

      const body = app.setup.renderer.root.findDescendantById("x-post-content-0")!
      const media = app.setup.renderer.root.findDescendantById("x-post-media-0")!
      const quote = app.setup.renderer.root.findDescendantById("x-post-quote-0")!
      const metrics = app.setup.renderer.root.findDescendantById("x-post-footer-0")!
      const quotedBody = app.setup.renderer.root.findDescendantById("x-post-quote-content-0")!
      const quotedMedia = app.setup.renderer.root.findDescendantById("x-post-quote-media-0")!
      const verticalGap = (before: Renderable, after: Renderable) => after.screenY - before.screenY - before.height

      expect(verticalGap(body, media)).toBe(1)
      expect(verticalGap(media, quote)).toBe(1)
      expect(verticalGap(quote, metrics)).toBe(1)
      expect(verticalGap(quotedBody, quotedMedia)).toBe(1)
      expect(quote.screenY + quote.height - 1 - (quotedMedia.screenY + quotedMedia.height)).toBe(1)

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("lays out one to four media items like X and marks overflow", async () => {
    const app = await createApp(40)
    const posts: Array<Record<string, unknown>> = []
    const media: Array<Record<string, unknown>> = []
    for (let count = 1; count <= 5; count += 1) {
      const mediaKeys: string[] = []
      for (let index = 0; index < count; index += 1) {
        const mediaKey = `mosaic-${count}-${index}`
        mediaKeys.push(mediaKey)
        media.push({
          media_key: mediaKey,
          type: "photo",
          url: index % 2 === 0 ? RED_PNG_DATA_URL : BLUE_PNG_DATA_URL,
          width: 1,
          height: 1,
        })
      }
      posts.push({ id: `74${count}`, text: `${count} image post`, attachments: { media_keys: mediaKeys } })
    }
    app.api.expectUser("mosaic-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("mosaic-token", "42", {
      body: { data: posts, includes: { media }, meta: {} },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "mosaic-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("1 image post"))
      await app.setup.flush({ maxPasses: 100 })
      const descendant = (id: string) => app.setup.renderer.root.findDescendantById(id)!

      expect(getImage(app, "x-post-media-image-0-0").fit).toBe("fit")

      const twoFirst = descendant("x-post-media-tile-1-0")
      const twoSecond = descendant("x-post-media-tile-1-1")
      expect(getImage(app, "x-post-media-image-1-0").fit).toBe("cover")
      expect(twoFirst.screenY).toBe(twoSecond.screenY)
      expect(twoFirst.height).toBe(twoSecond.height)
      expect(twoSecond.screenX - twoFirst.screenX - twoFirst.width).toBe(1)
      expect(Math.abs(twoFirst.width - twoSecond.width)).toBeLessThanOrEqual(1)

      const threeFirst = descendant("x-post-media-tile-2-0")
      const threeSecond = descendant("x-post-media-tile-2-1")
      const threeThird = descendant("x-post-media-tile-2-2")
      expect(threeFirst.height).toBe(descendant("x-post-media-2").height)
      expect(threeSecond.screenX).toBe(threeThird.screenX)
      expect(threeThird.screenY - threeSecond.screenY - threeSecond.height).toBe(1)
      expect(Math.abs(threeSecond.height - threeThird.height)).toBeLessThanOrEqual(1)

      const fourFirst = descendant("x-post-media-tile-3-0")
      const fourSecond = descendant("x-post-media-tile-3-1")
      const fourThird = descendant("x-post-media-tile-3-2")
      const fourFourth = descendant("x-post-media-tile-3-3")
      expect(fourFirst.screenY).toBe(fourSecond.screenY)
      expect(fourThird.screenY).toBe(fourFourth.screenY)
      expect(fourFirst.screenX).toBe(fourThird.screenX)
      expect(fourSecond.screenX).toBe(fourFourth.screenX)
      expect(fourThird.screenY - fourFirst.screenY - fourFirst.height).toBe(1)

      expect(app.setup.renderer.root.findDescendantById("x-post-media-image-4-4")).toBeUndefined()
      const overflow = descendant("x-post-media-more-4") as TextRenderable
      expect(overflow.content.chunks.map((chunk) => chunk.text).join("")).toBe("+1")

      for (let index = 0; index < 4; index += 1) app.setup.mockInput.pressKey("j")
      app.setup.mockInput.pressKey("i")
      await app.setup.waitForFrame((frame) => frame.includes("IMAGE · 1/5 · 100%"))
      for (let index = 0; index < 4; index += 1) app.setup.mockInput.pressArrow("right")
      await app.setup.waitForFrame((frame) => frame.includes("IMAGE · 5/5 · 100%"))
      app.setup.mockInput.pressEscape()

      app.setup.renderer.resize(7, 20)
      await app.setup.flush({ maxPasses: 100 })
      const narrowGrid = descendant("x-post-media-1")
      const narrowFirst = descendant("x-post-media-tile-1-0")
      const narrowSecond = descendant("x-post-media-tile-1-1")
      expect(narrowSecond.screenX - narrowFirst.screenX - narrowFirst.width).toBe(1)
      expect(narrowSecond.screenX + narrowSecond.width).toBeLessThanOrEqual(narrowGrid.screenX + narrowGrid.width)

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("reveals comments only after their media layout is stable", async () => {
    const app = await createApp(36)
    const commentsRequested = deferred<void>()
    const releaseComments = deferred<void>()
    app.api.expectUser("stable-comments-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("stable-comments-token", "42", {
      body: {
        data: [{ id: "7301", text: "Post with media", attachments: { media_keys: ["media-1"] } }],
        includes: {
          media: [
            {
              media_key: "media-1",
              type: "photo",
              url: RED_PNG_DATA_URL,
              width: 680,
              height: 594,
            },
          ],
        },
        meta: {},
      },
    })
    app.api.expectComments("stable-comments-token", "7301", async () => {
      commentsRequested.resolve()
      await releaseComments.promise
      return { body: { data: [], meta: {} } }
    })
    const recorder = new TestRecorder(app.setup.renderer)

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "stable-comments-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Post with media"))
      await app.setup.flush({ maxPasses: 50 })

      recorder.rec()
      app.setup.mockInput.pressKey("c")
      await commentsRequested.promise
      await app.setup.flush({ maxPasses: 50 })
      recorder.stop()

      const commentsFrames = recorder.recordedFrames
        .map((recorded) => recorded.frame)
        .filter((frame) => frame.includes("SELECTED POST"))
      expect(commentsFrames.length).toBeGreaterThan(0)
      const headingRows = commentsFrames.map((frame) =>
        frame.split("\n").findIndex((line) => line.includes("COMMENTS  DIRECT REPLIES")),
      )
      expect(headingRows.every((row) => row >= 0)).toBe(true)
      expect(new Set(headingRows).size).toBe(1)
      expect(commentsFrames[0]).toContain("J/K select   O open   I image   ESC back")

      releaseComments.resolve()
      await app.api.waitForResponseCount(3)
      app.api.assertDone()
      expectHealthy(app)
    } finally {
      recorder.stop()
      releaseComments.resolve()
      await app.close()
    }
  })

  test("shows paginated comments and restores the exact timeline view", async () => {
    const openedUrls: string[] = []
    const app = await createApp(12, {
      async openUrl(url) {
        openedUrls.push(url)
      },
    })
    const finalPageRequested = deferred<void>()
    const releaseFinalPage = deferred<void>()
    app.api.expectUser("comments-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("comments-token", "42", { body: { data: posts(1, 20), meta: {} } })
    app.api.expectComments("comments-token", "11", {
      body: {
        data: [{ id: "101", text: "First direct reply", author_id: "7" }],
        includes: { users: [{ id: "7", name: "Alice", username: "alice" }] },
        meta: { next_token: "comments-next" },
      },
    })
    app.api.expectComments(
      "comments-token",
      "11",
      {
        body: {
          data: [{ id: "101", text: "Duplicate reply", author_id: "7" }],
          includes: { users: [{ id: "7", name: "Alice", username: "alice" }] },
          meta: { next_token: "comments-final" },
        },
      },
      "comments-next",
    )
    app.api.expectComments(
      "comments-token",
      "11",
      async () => {
        finalPageRequested.resolve()
        await releaseFinalPage.promise
        return {
          body: {
            data: [{ id: "102", text: "Second direct reply", author_id: "8" }],
            includes: { users: [{ id: "8", name: "Bob", username: "bob" }] },
            meta: {},
          },
        }
      },
      "comments-final",
    )

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "comments-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Post 1"))
      for (let index = 0; index < 10; index += 1) app.setup.mockInput.pressKey("j")
      await app.setup.renderOnce()

      const timelineFeed = getScrollBox(app, "x-feed")
      const savedScrollTop = timelineFeed.scrollTop
      expect(savedScrollTop).toBeGreaterThan(0)
      expect(getCard(app, "11").backgroundColor.toInts()).toEqual([22, 24, 28, 255])

      app.setup.mockInput.pressKey("c")
      const commentsFrame = await waitForApiFrame(app, 3, (frame) => frame.includes("1 comment · scroll for more"))
      expect(commentsFrame).toContain("COMMENTS  @reader  ESC BACK · READ-ONLY")
      expect(commentsFrame).toContain("SELECTED POST")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-comments-feed")
      expect(app.setup.renderer.root.findDescendantById("x-comments-root-11")).toBeDefined()
      expect(app.setup.renderer.root.findDescendantById("x-comment-101")).toBeDefined()

      const commentsFeed = getScrollBox(app, "x-comments-feed")
      const childIds = commentsFeed.getChildren().map((child) => child.id)
      expect(childIds.indexOf("x-comments-root-11")).toBeLessThan(childIds.indexOf("x-comment-101"))
      commentsFeed.scrollTo(100_000)
      await finalPageRequested.promise
      releaseFinalPage.resolve()
      const completedFrame = await waitForApiFrame(app, 5, (frame) => frame.includes("2 comments · end of comments"))
      expect(completedFrame).toContain("Second direct reply")
      expect(completedFrame).toContain("J/K select   O open   I image   ESC back")
      expect(app.setup.renderer.root.findDescendantById("x-comment-101")).toBeDefined()
      expect(app.setup.renderer.root.findDescendantById("x-comment-102")).toBeDefined()
      const firstCommentCard = app.setup.renderer.root.findDescendantById("x-comment-101") as BoxRenderable
      const secondCommentCard = app.setup.renderer.root.findDescendantById("x-comment-102") as BoxRenderable
      expect(firstCommentCard.backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      expect(secondCommentCard.backgroundColor.toInts()).toEqual([8, 8, 8, 255])

      await clickRenderable(app, "x-comment-102")
      expect(firstCommentCard.backgroundColor.toInts()).toEqual([8, 8, 8, 255])
      expect(secondCommentCard.backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      app.setup.mockInput.pressKey("o")
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(openedUrls).toEqual(["https://x.com/bob/status/102"])
      app.setup.mockInput.pressKey("k")
      expect(firstCommentCard.backgroundColor.toInts()).toEqual([22, 24, 28, 255])

      await clickRenderable(app, "x-footer-back")
      const restoredFrame = await app.setup.waitForFrame(
        (frame) => frame.includes("Post 11") && !frame.includes("SELECTED POST"),
      )
      expect(restoredFrame).toContain("FOLLOWING")
      expect(restoredFrame).toContain("20 Following posts · X API v2 · read-only")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")
      expect(getScrollBox(app, "x-feed")).toBe(timelineFeed)
      expect(timelineFeed.scrollTop).toBe(savedScrollTop)
      expect(getCard(app, "11").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      expect(app.setup.renderer.root.findDescendantById("x-comment-101")).toBeUndefined()

      app.setup.mockInput.pressKey("q")
      app.setup.mockInput.pressEscape()
      expect(app.setup.renderer.isDestroyed).toBe(false)
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")
      app.setup.mockInput.pressCtrlC()
      expect(app.setup.renderer.isDestroyed).toBe(true)

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      releaseFinalPage.resolve()
      await app.close()
    }
  })

  test("loads browser-session comments through Bird cursor pages", async () => {
    const timelineTweet: TweetData = {
      id: "601",
      text: "Browser timeline post",
      author: { name: "Browser User", username: "browser_user" },
    }
    const firstComment: TweetData = {
      id: "602",
      text: "Browser comment one",
      author: { name: "Alice", username: "alice" },
      inReplyToStatusId: "601",
    }
    const secondComment: TweetData = {
      id: "603",
      text: "Browser comment two",
      author: { name: "Bob", username: "bob" },
      inReplyToStatusId: "601",
    }
    const repliesCalls: Array<{ tweetId: string; options: Record<string, unknown> }> = []
    let homeCalls = 0
    let followingCalls = 0
    let clientOptions: ConstructorParameters<typeof TwitterClient>[0] | null = null
    const fakeClient = {
      async getHomeTimeline() {
        homeCalls += 1
        return { tweets: [timelineTweet] }
      },
      async getHomeLatestTimeline() {
        followingCalls += 1
        return { tweets: [{ ...timelineTweet, text: "Browser following post" }] }
      },
      async getRepliesPaged(tweetId: string, options: Record<string, unknown>) {
        repliesCalls.push({ tweetId, options })
        return options.cursor
          ? { success: true, tweets: [secondComment] }
          : { success: true, tweets: [firstComment], nextCursor: "browser-next" }
      },
    } as unknown as TwitterClient
    const app = await createApp(12, {
      twitterClientFactory(options) {
        clientOptions = options
        return fakeClient
      },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await clickSelectOption(app, "x-connection-select", 1)
      await app.setup.waitForFrame((frame) => frame.includes("ACCOUNT RISK"))
      await clickSelectOption(app, "x-cookie-risk-select", 1)
      await app.setup.waitForFrame((frame) => frame.includes("Use a session token or your browser login"))
      await clickRenderable(app, "x-auth-input-box")
      await app.setup.mockInput.typeText("auth_token=test-auth; ct0=test-csrf")
      await clickRenderable(app, "x-auth-hint-submit")
      const timelineFrame = await app.setup.waitForFrame((frame) => frame.includes("Browser timeline post"))
      expect(timelineFrame).toContain("unofficial cookie mode")
      expect(clientOptions?.cookies.authToken).toBe("test-auth")
      expect(clientOptions?.cookies.ct0).toBe("test-csrf")

      await clickRenderable(app, "x-header-following")
      await app.setup.waitForFrame((frame) => frame.includes("Browser following post"))
      expect(followingCalls).toBe(1)
      await clickRenderable(app, "x-header-home")
      await app.setup.waitForFrame((frame) => frame.includes("Browser timeline post"))
      expect(homeCalls).toBe(1)

      await clickRenderable(app, "x-footer-comments")
      for (let attempt = 0; attempt < 20 && repliesCalls.length < 2; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        getScrollBox(app, "x-comments-feed").scrollTo(100_000)
        await app.setup.renderOnce()
      }
      const commentsFrame = await app.setup.waitForFrame((frame) => frame.includes("2 comments · end of comments"))
      expect(commentsFrame).toContain("2 comments · end of comments")
      expect(app.setup.renderer.root.findDescendantById("x-comment-603")).toBeDefined()
      expect(repliesCalls).toEqual([
        {
          tweetId: "601",
          options: { maxPages: 1, cursor: undefined, pageDelayMs: 0, includeRaw: true },
        },
        {
          tweetId: "601",
          options: { maxPages: 1, cursor: "browser-next", pageDelayMs: 0, includeRaw: true },
        },
      ])

      app.setup.mockInput.pressEscape()
      await app.setup.waitForFrame(
        (frame) => frame.includes("Browser timeline post") && !frame.includes("SELECTED POST"),
      )
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")
      expect(app.api.requests).toHaveLength(0)
      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("caches Home and Following independently while loading both", async () => {
    const homeRequested = deferred<void>()
    const followingRequested = deferred<void>()
    const releaseHome = deferred<void>()
    const releaseFollowing = deferred<void>()
    const homeFinished = deferred<void>()
    const followingFinished = deferred<void>()
    let homeCalls = 0
    let followingCalls = 0
    const browserPosts = (start: number) =>
      Array.from(
        { length: 12 },
        (_, index): TweetData => ({
          id: String(start + index),
          text: index === 0 ? `Post ${start + index} ${"long ".repeat(70)}` : `Post ${start + index}`,
          author: { name: "Reader", username: "reader" },
        }),
      )
    const fakeClient = {
      async getHomeTimeline() {
        homeCalls += 1
        homeRequested.resolve()
        await releaseHome.promise
        homeFinished.resolve()
        return { tweets: browserPosts(1) }
      },
      async getHomeLatestTimeline() {
        followingCalls += 1
        followingRequested.resolve()
        await releaseFollowing.promise
        followingFinished.resolve()
        return { tweets: browserPosts(101) }
      },
    } as unknown as TwitterClient
    const app = await createApp(12, {
      twitterClientFactory() {
        return fakeClient
      },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginCookie(app)
      await homeRequested.promise
      const homeLoading = await app.setup.waitForFrame((frame) => frame.includes("Loading Home"))
      expect(homeLoading).toContain("LOADING HOME")
      const loadingViewportHeight = getScrollBox(app, "x-feed").viewport.height
      const activityRow = app.setup.renderer.root.findDescendantById("x-activity-row")
      expect(activityRow?.width).toBe(100)
      expect(activityRow?.height).toBe(1)
      expect(app.setup.renderer.root.findDescendantById("x-activity-spinner")?.visible).toBe(true)

      await clickRenderable(app, "x-header-following")
      await followingRequested.promise
      const overlapping = await app.setup.waitForFrame(
        (frame) => frame.includes("Loading Following") && frame.includes("2 operations"),
      )
      expect(overlapping).toContain("LOADING FOLLOWING")

      await clickRenderable(app, "x-header-home")
      expect(homeCalls).toBe(1)
      releaseFollowing.resolve()
      await followingFinished.promise
      const stillLoadingHome = await app.setup.waitForFrame(
        (frame) => frame.includes("Loading Home") && !frame.includes("2 operations"),
      )
      expect(stillLoadingHome).not.toContain("Post 101")

      releaseHome.resolve()
      await homeFinished.promise
      await app.setup.waitForFrame((frame) => frame.includes("Post 1"))
      const homeFeed = getScrollBox(app, "x-feed")
      expect(homeFeed.viewport.height).toBe(loadingViewportHeight + 1)
      app.setup.mockInput.pressKey("e")
      await app.setup.waitForFrame((frame) => frame.includes("[E] Show Less"))
      for (let index = 0; index < 5; index += 1) app.setup.mockInput.pressKey("j")
      await app.setup.renderOnce()
      const homeScrollTop = homeFeed.scrollTop
      expect(homeScrollTop).toBeGreaterThan(0)
      expect(getCard(app, "6").backgroundColor.toInts()).toEqual([22, 24, 28, 255])

      await clickRenderable(app, "x-header-following")
      const followingFrame = await app.setup.waitForFrame((frame) => frame.includes("Post 101"))
      expect(followingFrame).not.toContain("Loading Following")
      const followingFeed = getScrollBox(app, "x-feed")
      expect(followingFeed).not.toBe(homeFeed)
      for (let index = 0; index < 3; index += 1) app.setup.mockInput.pressKey("j")
      await app.setup.renderOnce()
      const followingScrollTop = followingFeed.scrollTop
      expect(followingScrollTop).toBeGreaterThan(0)

      await clickRenderable(app, "x-header-home")
      expect(getScrollBox(app, "x-feed")).toBe(homeFeed)
      expect(homeFeed.scrollTop).toBe(homeScrollTop)
      expect(getCard(app, "6").backgroundColor.toInts()).toEqual([22, 24, 28, 255])
      const homeToggle = app.setup.renderer.root.findDescendantById("x-post-toggle-1") as TextRenderable
      expect(homeToggle.content.chunks.map((chunk) => chunk.text).join("")).toContain("Show Less")

      await clickRenderable(app, "x-header-following")
      expect(getScrollBox(app, "x-feed")).toBe(followingFeed)
      expect(followingFeed.scrollTop).toBe(followingScrollTop)
      expect(homeCalls).toBe(1)
      expect(followingCalls).toBe(1)
      expect(app.setup.renderer.root.findDescendantById("x-activity-spinner")?.visible).toBe(false)
      expectHealthy(app)
    } finally {
      releaseHome.resolve()
      releaseFollowing.resolve()
      await app.close()
    }
  })

  test("uses the activity row only while loading", async () => {
    const timelineRequested = deferred<void>()
    const releaseTimeline = deferred<void>()
    const app = await createApp(12)
    app.api.expectUser("activity-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("activity-token", "42", async () => {
      timelineRequested.resolve()
      await releaseTimeline.promise
      return { body: { data: [{ id: "201", text: "Activity row settled" }], meta: {} } }
    })

    try {
      await loginOfficial(app, "activity-token")
      await timelineRequested.promise
      await app.setup.waitForFrame((frame) => frame.includes("Loading Following"))
      const activityRow = app.setup.renderer.root.findDescendantById("x-activity-row")!
      const activitySpinner = app.setup.renderer.root.findDescendantById("x-activity-spinner")!
      const viewStack = app.setup.renderer.root.findDescendantById("x-view-stack")!
      const footer = app.setup.renderer.root.findDescendantById("x-footer")!
      const loadingViewHeight = viewStack.height

      expect(activityRow.visible).toBe(true)
      expect(activityRow.height).toBe(1)
      expect(activitySpinner.visible).toBe(true)
      expect(viewStack.screenY + viewStack.height).toBe(activityRow.screenY)
      expect(activityRow.screenY + activityRow.height).toBe(footer.screenY)

      releaseTimeline.resolve()
      await waitForApiFrame(app, 2, (frame) => frame.includes("Activity row settled"))
      await app.setup.flush({ maxPasses: 100 })

      expect(activitySpinner.visible).toBe(false)
      expect(activityRow.visible).toBe(false)
      expect(viewStack.height).toBe(loadingViewHeight + 1)
      expect(viewStack.screenY + viewStack.height).toBe(footer.screenY)
      expect(footer.height).toBe(1)
      expect(footer.screenY + footer.height).toBe(app.setup.renderer.height)
      app.api.assertDone()
      expectHealthy(app)
    } finally {
      releaseTimeline.resolve()
      await app.close()
    }
  })

  test("renders browser-session retweets from the complete original tweet", async () => {
    const openedUrls: string[] = []
    const originalText =
      "Engineers and CTOs on X: I wrote this for you. https://t.co/original-one\n\nModels and devs on X: I wrote this for you both. https://t.co/original-two\n\nEnjoy. Or not."
    const outerTweet: TweetData = {
      id: "2084577946098905462",
      text: "RT @Steve_Yegge: Engineers and CTOs on X: I wrote this for you. https://t.co/wrapper\n\nModels and devs on X: I wrote this for you both. h…",
      author: { name: "Matteo Collina", username: "matteocollina" },
      replyCount: 0,
      retweetCount: 90,
      likeCount: 0,
      _raw: {
        rest_id: "2084577946098905462",
        legacy: {
          full_text:
            "RT @Steve_Yegge: Engineers and CTOs on X: I wrote this for you. https://t.co/wrapper\n\nModels and devs on X: I wrote this for you both. h…",
          retweeted_status_result: {
            result: {
              rest_id: "2084171673369219375",
              core: {
                user_results: {
                  result: {
                    user: {
                      rest_id: "123",
                      legacy: { name: "Steve Yegge", screen_name: "Steve_Yegge" },
                    },
                  },
                },
              },
              legacy: {
                full_text: "Legacy original text",
                created_at: "Tue Aug 04 12:00:00 +0000 2026",
                reply_count: 21,
                quote_count: 7,
                retweet_count: 1,
                favorite_count: 46,
                conversation_id_str: "2084171673369219375",
                extended_entities: {
                  media: [
                    {
                      media_url_https: RED_PNG_DATA_URL,
                      type: "photo",
                      sizes: { large: { w: 1, h: 1 } },
                    },
                  ],
                },
              },
              note_tweet: { note_tweet_results: { result: { text: originalText } } },
            },
          },
        },
      } as unknown as NonNullable<TweetData["_raw"]>,
    }
    const articleRetweet: TweetData = {
      id: "article-repost",
      text: "RT @article_author: Article title…",
      author: { name: "Article Reposter", username: "article_reposter" },
      _raw: {
        rest_id: "article-repost",
        legacy: {
          full_text: "RT @article_author: Article title…",
          retweeted_status_result: {
            result: {
              rest_id: "article-original",
              core: {
                user_results: {
                  result: {
                    rest_id: "article-user",
                    legacy: { name: "Article Author", screen_name: "article_author" },
                  },
                },
              },
              legacy: { full_text: "Article title https://t.co/article", reply_count: 3, favorite_count: 5 },
              article: {
                article_results: {
                  result: {
                    title: "Article title",
                    content_state: {
                      blocks: [
                        { key: "title", type: "header-one", text: "Article title" },
                        { key: "body", type: "unstyled", text: "Full article body from content state." },
                      ],
                      entityMap: {},
                    },
                  },
                },
              },
            },
          },
        },
      } as unknown as NonNullable<TweetData["_raw"]>,
    }
    const repliesCalls: string[] = []
    const fakeClient = {
      async getHomeTimeline() {
        return { tweets: [outerTweet, articleRetweet] }
      },
      async getHomeLatestTimeline() {
        return { tweets: [outerTweet, articleRetweet] }
      },
      async getRepliesPaged(tweetId: string) {
        repliesCalls.push(tweetId)
        return { success: true, tweets: [] }
      },
    } as unknown as TwitterClient
    const app = await createApp(40, {
      twitterClientFactory() {
        return fakeClient
      },
      async openUrl(url) {
        openedUrls.push(url)
      },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await clickSelectOption(app, "x-connection-select", 1)
      await app.setup.waitForFrame((frame) => frame.includes("ACCOUNT RISK"))
      await clickSelectOption(app, "x-cookie-risk-select", 1)
      await app.setup.waitForFrame((frame) => frame.includes("Use a session token or your browser login"))
      await clickRenderable(app, "x-auth-input-box")
      await app.setup.mockInput.typeText("auth_token=test-auth; ct0=test-csrf")
      await clickRenderable(app, "x-auth-hint-submit")

      const frame = await app.setup.waitForFrame((value) => value.includes("Matteo Collina reposted"))
      expect(frame).toContain("Steve Yegge @Steve_Yegge")
      expect(frame).toContain("Enjoy. Or not.")
      expect(frame).not.toContain("RT @Steve_Yegge")
      expect(frame).not.toContain("both. h…")
      expect(frame).toContain("↩ 21")
      expect(frame).toContain("♥ 46")
      expect(frame).toContain("↻ 1")
      expect(getCard(app, "2084577946098905462")).toBeDefined()
      expect(app.setup.renderer.root.findDescendantById("x-post-2084171673369219375")).toBeUndefined()

      app.setup.mockInput.pressKey("o")
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(openedUrls).toEqual(["https://x.com/Steve_Yegge/status/2084171673369219375"])

      app.setup.mockInput.pressKey("i")
      const imageFrame = await app.setup.waitForFrame((value) => value.includes("IMAGE · 100%"))
      expect(imageFrame).toContain("21 replies   7 quotes   46 likes")
      expect(getImage(app, "x-image-view-image").source).toBe(RED_PNG_DATA_URL)
      app.setup.mockInput.pressEscape()

      app.setup.mockInput.pressKey("j")
      const articleFrame = await app.setup.waitForFrame((value) =>
        value.includes("Full article body from content state."),
      )
      expect(articleFrame).toContain("Article Reposter reposted")
      expect(articleFrame).toContain("Article Author @article_author")
      expect(articleFrame).not.toContain("RT @article_author")
      expect(getCard(app, "article-repost")).toBeDefined()
      app.setup.mockInput.pressKey("k")

      app.setup.mockInput.pressKey("c")
      const commentsFrame = await app.setup.waitForFrame((value) => value.includes("NO DIRECT REPLIES FOUND"))
      expect(commentsFrame).toContain("Steve Yegge @Steve_Yegge")
      expect(commentsFrame).toContain("Matteo Collina reposted")
      expect(repliesCalls).toEqual(["2084171673369219375"])

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("keeps the selected post at the top when no recent comments are found", async () => {
    const app = await createApp(18)
    app.api.expectUser("no-comments-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("no-comments-token", "42", {
      body: { data: [{ id: "301", text: "Post without recent comments" }], meta: {} },
    })
    app.api.expectComments("no-comments-token", "301", { body: { data: [], meta: {} } })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "no-comments-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Post without recent comments"))
      app.setup.mockInput.pressKey("c")

      const emptyFrame = await waitForApiFrame(app, 3, (frame) => frame.includes("NO RECENT DIRECT REPLIES FOUND"))
      expect(emptyFrame).toContain("Post without recent comments")
      expect(emptyFrame).toContain("X SEARCH COVERS THE LAST 7 DAYS")
      expect(emptyFrame).toContain("0 comments · end of comments")

      app.setup.mockInput.pressEscape()
      await app.setup.waitForFrame(
        (frame) => frame.includes("Post without recent comments") && !frame.includes("SELECTED POST"),
      )
      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("keeps the selected post visible when comments fail", async () => {
    const app = await createApp(18)
    app.api.expectUser("comments-error-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("comments-error-token", "42", {
      body: { data: [{ id: "401", text: "Post with unavailable replies" }], meta: {} },
    })
    app.api.expectComments("comments-error-token", "401", {
      status: 403,
      body: { errors: [{ detail: "Replies unavailable" }] },
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "comments-error-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Post with unavailable replies"))
      app.setup.mockInput.pressKey("c")

      const errorFrame = await waitForApiFrame(app, 3, (frame) => frame.includes("COMMENTS UNAVAILABLE"))
      expect(errorFrame).toContain("Post with unavailable replies")
      expect(errorFrame).toContain("X API HTTP 403: Replies unavailable")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-comments-feed")

      app.setup.mockInput.pressEscape()
      await app.setup.waitForFrame(
        (frame) => frame.includes("Post with unavailable replies") && !frame.includes("COMMENTS"),
      )
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      await app.close()
    }
  })

  test("ignores a comments response after returning to the timeline", async () => {
    const app = await createApp(18)
    const commentsRequested = deferred<void>()
    const releaseComments = deferred<void>()
    app.api.expectUser("comments-back-token", {
      body: { data: { id: "42", name: "Reader", username: "reader" } },
    })
    app.api.expectTimeline("comments-back-token", "42", {
      body: { data: [{ id: "501", text: "Stay on timeline" }], meta: {} },
    })
    app.api.expectComments("comments-back-token", "501", async () => {
      commentsRequested.resolve()
      await releaseComments.promise
      return { body: { data: [{ id: "502", text: "Late comment" }], meta: {} } }
    })

    try {
      await app.setup.waitForFrame((frame) => frame.includes("CONNECT X"))
      await loginOfficial(app, "comments-back-token")
      await waitForApiFrame(app, 2, (frame) => frame.includes("Stay on timeline"))
      const timelineFeed = getScrollBox(app, "x-feed")
      const savedScrollTop = timelineFeed.scrollTop

      app.setup.mockInput.pressKey("c")
      await commentsRequested.promise
      await app.setup.waitForFrame((frame) => frame.includes("LOADING COMMENTS"))
      const commentsFeed = getScrollBox(app, "x-comments-feed")
      app.setup.mockInput.pressEscape()
      const restoredFrame = await app.setup.waitForFrame(
        (frame) => frame.includes("Stay on timeline") && !frame.includes("SELECTED POST"),
      )
      expect(restoredFrame).toContain("1 Following posts · X API v2 · read-only")
      expect(app.setup.renderer.currentFocusedRenderable?.id).toBe("x-feed")
      expect(timelineFeed.scrollTop).toBe(savedScrollTop)

      releaseComments.resolve()
      await app.api.waitForResponseCount(3)
      await Bun.sleep(10)
      await app.setup.renderOnce()
      expect(app.setup.renderer.root.findDescendantById("x-comment-502")).toBeUndefined()
      expect(commentsFeed.findDescendantById("x-comment-502")).toBeUndefined()
      const finalFrame = app.setup.captureCharFrame()
      expect(finalFrame).toContain("1 Following posts · X API v2 · read-only")
      expect(finalFrame).not.toContain("1 comment · end of comments")

      app.api.assertDone()
      expectHealthy(app)
    } finally {
      releaseComments.resolve()
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

      app.setup.mockInput.pressCtrlC()
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

      app.setup.mockInput.pressCtrlC()
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
