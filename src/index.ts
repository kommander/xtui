#!/usr/bin/env bun

import { spawn } from "node:child_process"
import {
  BoxRenderable,
  CliRenderEvents,
  ConsolePosition,
  type CliRenderer,
  ImageError,
  ImageLoadError,
  ImageRenderable,
  InputRenderable,
  InputRenderableEvents,
  MouseButton,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  TextAttributes,
  TextRenderable,
  bold,
  createCliRenderer,
  dim,
  fg,
  t,
  underline,
  type KeyEvent,
  type MouseEvent,
  type Renderable,
  type SelectOption,
  type TextChunk,
} from "@opentui/core"
import type { Keymap } from "@opentui/keymap"
import { commandBindings, formatCommandBindings } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { TwitterClient, type TweetData, type TwitterCookies } from "@steipete/bird"
import { mapTweetResult } from "@steipete/bird/dist/lib/twitter-client-utils.js"
import { SpinnerRenderable } from "opentui-spinner"
import {
  ALL_PROFILES,
  getCookies,
  toCookieHeader,
  type BrowserName,
  type Cookie,
  type GetCookiesOptions,
} from "@steipete/sweet-cookie"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { loadRememberedBrowserSource, rememberBrowserSource, type BrowserSourceId } from "./browser-preference.js"
import {
  DEFAULT_CONFIG,
  DEFAULT_KEYBINDINGS,
  formatConfigIssue,
  loadConfig,
  type ConfigIssue,
  type XtuiCommandName,
  type XtuiConfig,
} from "./config.js"

export type { BrowserSourceId } from "./browser-preference.js"

const COLORS = {
  background: "#000000",
  panel: "#16181C",
  card: "#080808",
  cardActive: "#16181C",
  border: "#2F3336",
  borderActive: "#EFF3F4",
  primary: "#E7E9EA",
  secondary: "#71767B",
  muted: "#536471",
  accent: "#F2F2F2",
  selectedBackground: "#EFF3F4",
  selectedText: "#0F1419",
  selectedDescription: "#536471",
  mention: "#AAB8C2",
  green: "#00BA7C",
  pink: "#F91880",
  amber: "#FFD400",
  error: "#F4212E",
} as const

const PAGE_SIZE = 20
const OFFICIAL_REFRESH_COOLDOWN_MS = 15_000
const COOKIE_REFRESH_COOLDOWN_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const MEDIA_MIN_ROWS = 5
const MEDIA_MAX_ROWS = 18
const MEDIA_CARD_HORIZONTAL_INSET = 4
const IMAGE_ZOOM_STEP = 0.25
const IMAGE_MIN_ZOOM = 0.5
const IMAGE_MAX_ZOOM = 4
const IMAGE_PAN_COLUMNS = 2
const IMAGE_PAN_ROWS = 1
const IMAGE_CHROME_ROWS = 1
const POST_PREVIEW_GRAPHEMES = 280
const X_API_BASE_URL = "https://api.x.com"
const COMMENTS_PAGE_SIZE = 100
const FEED_COMMANDS = [
  "x.feed.next",
  "x.feed.previous",
  "x.feed.open",
  "x.feed.image",
  "x.feed.comments",
  "x.feed.refresh",
  "x.feed.toggle-expanded",
  "x.feed.switch-stream",
  "x.session.open",
] as const satisfies readonly XtuiCommandName[]
const COMMENTS_COMMANDS = [
  "x.comments.next",
  "x.comments.previous",
  "x.comments.open",
  "x.comments.image",
  "x.comments.back",
] as const satisfies readonly XtuiCommandName[]
const IMAGE_COMMANDS = [
  "x.image.next",
  "x.image.previous",
  "x.image.zoom-in",
  "x.image.zoom-out",
  "x.image.pan-left",
  "x.image.pan-down",
  "x.image.pan-up",
  "x.image.pan-right",
  "x.image.close",
] as const satisfies readonly XtuiCommandName[]
const APP_COMMANDS = ["app.quit", "app.console"] as const satisfies readonly XtuiCommandName[]

const COMMAND_DETAILS = {
  "x.feed.next": { title: "Next post", category: "Timeline", order: 10 },
  "x.feed.previous": { title: "Previous post", category: "Timeline", order: 11 },
  "x.feed.open": { title: "Open selected post", category: "Timeline", order: 12 },
  "x.feed.image": { title: "View selected image", category: "Timeline", order: 13 },
  "x.feed.comments": { title: "View comments", category: "Timeline", order: 14 },
  "x.feed.refresh": { title: "Refresh timeline", category: "Timeline", order: 15 },
  "x.feed.toggle-expanded": { title: "Show more / less", category: "Timeline", order: 16 },
  "x.feed.switch-stream": { title: "Switch Home / Following", category: "Timeline", order: 17 },
  "x.session.open": { title: "Change session", category: "Timeline", order: 18 },
  "x.comments.next": { title: "Next item", category: "Comments", order: 20 },
  "x.comments.previous": { title: "Previous item", category: "Comments", order: 21 },
  "x.comments.open": { title: "Open selected post", category: "Comments", order: 22 },
  "x.comments.image": { title: "View selected image", category: "Comments", order: 23 },
  "x.comments.back": { title: "Back to timeline", category: "Comments", order: 24 },
  "x.image.next": { title: "Next image", category: "Image", order: 30 },
  "x.image.previous": { title: "Previous image", category: "Image", order: 31 },
  "x.image.zoom-in": { title: "Zoom in", category: "Image", order: 32 },
  "x.image.zoom-out": { title: "Zoom out", category: "Image", order: 33 },
  "x.image.pan-left": { title: "Pan left", category: "Image", order: 34 },
  "x.image.pan-down": { title: "Pan down", category: "Image", order: 35 },
  "x.image.pan-up": { title: "Pan up", category: "Image", order: 36 },
  "x.image.pan-right": { title: "Pan right", category: "Image", order: 37 },
  "x.image.close": { title: "Close image", category: "Image", order: 38 },
  "x.modal.back": { title: "Back", category: "Dialog", order: 40 },
  "app.bindings": { title: "Show bindings", category: "Application", order: 50 },
  "app.console": { title: "Toggle logs", category: "Application", order: 51 },
  "app.quit": { title: "Quit", category: "Application", order: 52 },
} as const satisfies Record<XtuiCommandName, { title: string; category: string; order: number }>

interface CookieSource {
  id: BrowserSourceId
  label: string
  description: string
  browser: BrowserName
  detected(): boolean
  configure(options: GetCookiesOptions): void
}

export interface XDemoRunOptions {
  detectedBrowsers?: BrowserSourceId[]
  xApiBaseUrl?: string
  twitterClientFactory?: (options: ConstructorParameters<typeof TwitterClient>[0]) => TwitterClient
  openUrl?: (url: string) => Promise<void>
  config?: XtuiConfig
  configPath?: string
}

function safeDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function findChromiumProfilePaths(root: string): string[] {
  return safeDirectories(root)
    .map((entry) => join(root, entry))
    .filter((profile) => existsSync(join(profile, "Cookies")) || existsSync(join(profile, "Network", "Cookies")))
}

function hasChromiumStore(root: string | null): boolean {
  return root !== null && findChromiumProfilePaths(root).length > 0
}

function getXdgConfigHome(): string {
  const configured = process.env.XDG_CONFIG_HOME?.trim()
  return configured && isAbsolute(configured) ? configured : join(homedir(), ".config")
}

function getChromiumRoot(browser: "chrome" | "brave" | "edge"): string | null {
  if (process.platform === "darwin") {
    const directory =
      browser === "chrome"
        ? ["Google", "Chrome"]
        : browser === "brave"
          ? ["BraveSoftware", "Brave-Browser"]
          : ["Microsoft Edge"]
    return join(homedir(), "Library", "Application Support", ...directory)
  }

  if (process.platform === "linux") {
    const directory =
      browser === "chrome" ? "google-chrome" : browser === "brave" ? "BraveSoftware/Brave-Browser" : "microsoft-edge"
    return join(getXdgConfigHome(), ...directory.split("/"))
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) return null
    const directory =
      browser === "chrome"
        ? ["Google", "Chrome", "User Data"]
        : browser === "brave"
          ? ["BraveSoftware", "Brave-Browser", "User Data"]
          : ["Microsoft", "Edge", "User Data"]
    return join(localAppData, ...directory)
  }

  return null
}

function getFirefoxRoots(): string[] {
  if (process.platform === "darwin") {
    return [join(homedir(), "Library", "Application Support", "Firefox", "Profiles")]
  }
  if (process.platform === "linux") {
    return [join(getXdgConfigHome(), "mozilla", "firefox"), join(homedir(), ".mozilla", "firefox")]
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return [join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles")]
  }
  return []
}

function hasFirefoxStore(): boolean {
  return getFirefoxRoots().some((root) =>
    safeDirectories(root).some((profile) => existsSync(join(root, profile, "cookies.sqlite"))),
  )
}

function getSafariCookieFiles(): string[] {
  if (process.platform !== "darwin") return []
  return [
    join(homedir(), "Library", "Cookies", "Cookies.binarycookies"),
    join(homedir(), "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies"),
  ]
}

function getBraveProfiles(): GetCookiesOptions["chromeProfile"] {
  if (process.platform === "darwin") return ALL_PROFILES
  const root = getChromiumRoot("brave")
  return root ? findChromiumProfilePaths(root) : []
}

const COOKIE_SOURCES: CookieSource[] = [
  {
    id: "chrome",
    label: "Chrome",
    description: "Google Chrome profiles",
    browser: "chrome",
    detected: () => hasChromiumStore(getChromiumRoot("chrome")),
    configure(options) {
      options.chromiumBrowser = "chrome"
      options.chromeProfile = ALL_PROFILES
    },
  },
  {
    id: "brave",
    label: "Brave",
    description: "Brave Browser profiles",
    browser: "chrome",
    detected: () => hasChromiumStore(getChromiumRoot("brave")),
    configure(options) {
      options.chromiumBrowser = "brave"
      options.chromeProfile = getBraveProfiles()
    },
  },
  {
    id: "edge",
    label: "Edge",
    description: "Microsoft Edge profiles",
    browser: "edge",
    detected: () => hasChromiumStore(getChromiumRoot("edge")),
    configure(options) {
      options.edgeProfile = ALL_PROFILES
    },
  },
  {
    id: "firefox",
    label: "Firefox",
    description: "Mozilla Firefox profiles",
    browser: "firefox",
    detected: hasFirefoxStore,
    configure(options) {
      options.firefoxProfile = ALL_PROFILES
    },
  },
  {
    id: "safari",
    label: "Safari",
    description: "Safari cookie store",
    browser: "safari",
    detected: () => getSafariCookieFiles().some(existsSync),
    configure() {},
  },
]

interface BrowserSession {
  cookies: TwitterCookies
  source: string
  warnings: string[]
}

interface XApiUser {
  id: string
  name: string
  username: string
  profile_image_url?: string
}

interface XApiPost {
  id: string
  text: string
  author_id?: string
  created_at?: string
  note_tweet?: { text?: string }
  attachments?: {
    media_keys?: string[]
  }
  referenced_tweets?: Array<{
    id: string
    type: "retweeted" | "quoted" | "replied_to"
  }>
  entities?: {
    urls?: XApiUrlEntity[]
  }
  public_metrics?: {
    reply_count?: number
    quote_count?: number
    retweet_count?: number
    like_count?: number
  }
}

interface XApiUrlEntity {
  url: string
  expanded_url?: string
  display_url?: string
  media_key?: string
}

interface XApiMedia {
  media_key: string
  type: "photo" | "video" | "animated_gif"
  url?: string
  preview_image_url?: string
  width?: number
  height?: number
  duration_ms?: number
}

interface XApiResponse<T> {
  data?: T
  includes?: {
    users?: XApiUser[]
    media?: XApiMedia[]
    tweets?: XApiPost[]
  }
  meta?: {
    next_token?: string
  }
  errors?: Array<{
    title?: string
    detail?: string
    message?: string
  }>
}

type ConnectionMode = "official" | "cookie"
type TimelineStream = "home" | "following"
type ModalRoute = "connection" | "official-token" | "cookie-risk" | "cookie-auth" | "browser"
type AppView = "timeline" | "comments"

interface CommentsPage {
  tweets: TweetData[]
  nextCursor: string | null
}

interface CommentsItem {
  kind: "root" | "comment"
  tweet: TweetData
  card: BoxRenderable
}

interface TimelineReturnState {
  stream: TimelineStream
}

interface TimelineStatus {
  message: string
  color: string
}

interface TimelineStreamState {
  stream: TimelineStream
  feed: ScrollBoxRenderable
  cards: BoxRenderable[]
  tweets: TweetData[]
  tweetIds: Set<string>
  postBodies: Map<string, TextRenderable>
  postToggles: Map<string, TextRenderable>
  expandedPostIds: Set<string>
  selectedIndex: number
  hasMore: boolean
  officialNextToken: string | null
  cookieRequestedCount: number
  nextRefreshAt: number
  status: TimelineStatus
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  requestEpoch: number
  emptyState: BoxRenderable | null
}

interface LoadingActivity {
  label: string
  priority: number
}

interface LoadingActivityHandle {
  update(label: string): void
  done(): void
}

type TweetMedia = NonNullable<TweetData["media"]>[number]
interface RepostContext {
  id: string
  author: TweetData["author"]
}

type AppTweetData = TweetData & {
  wrapperUrls?: string[]
  timelineItemId?: string
  repostedBy?: RepostContext
}

interface BirdRawMedia {
  media_url_https?: string
  type?: "photo" | "video" | "animated_gif"
  url?: string
  expanded_url?: string
  sizes?: {
    small?: { w: number; h: number }
    medium?: { w: number; h: number }
    large?: { w: number; h: number }
  }
  video_info?: {
    duration_millis?: number
    variants?: Array<{ bitrate?: number; content_type?: string; url?: string }>
  }
}

interface BirdRawUser {
  user?: BirdRawUser
  rest_id?: string
  id?: string
  legacy?: { screen_name?: string; name?: string; profile_image_url_https?: string }
  core?: { screen_name?: string; name?: string }
  avatar?: { image_url?: string }
}

interface BirdRawTweet {
  rest_id?: string
  tweet?: BirdRawTweet
  legacy?: {
    full_text?: string
    created_at?: string
    reply_count?: number
    quote_count?: number
    retweet_count?: number
    favorite_count?: number
    conversation_id_str?: string
    in_reply_to_status_id_str?: string | null
    entities?: { urls?: XApiUrlEntity[]; media?: BirdRawMedia[] }
    extended_entities?: { media?: BirdRawMedia[] }
    retweeted_status_result?: { result?: BirdRawTweet }
  }
  core?: {
    user_results?: {
      result?: BirdRawUser
    }
  }
  note_tweet?: {
    note_tweet_results?: {
      result?: {
        text?: string
        richtext?: { text?: string }
        rich_text?: { text?: string }
        content?: { text?: string; richtext?: { text?: string }; rich_text?: { text?: string } }
      }
    }
  }
  article?: Record<string, unknown>
  quoted_status_result?: { result?: BirdRawTweet }
}

const rendererKeymaps = new WeakMap<CliRenderer, Keymap<Renderable, KeyEvent>>()

let root: BoxRenderable | null = null
let currentRenderer: CliRenderer | null = null
let activeConfig: XtuiConfig = DEFAULT_CONFIG
let feed: ScrollBoxRenderable | null = null
let commentsFeed: ScrollBoxRenderable | null = null
let statusText: TextRenderable | null = null
let headerText: TextRenderable | null = null
let headerHomeText: TextRenderable | null = null
let headerFollowingText: TextRenderable | null = null
let headerActionText: TextRenderable | null = null
let footer: BoxRenderable | null = null
let activityRow: BoxRenderable | null = null
let activitySpinner: SpinnerRenderable | null = null
let activityLabel: TextRenderable | null = null
let authOverlay: BoxRenderable | null = null
let authInput: InputRenderable | null = null
let authSelect: SelectRenderable | null = null
let authHint: TextRenderable | null = null
let client: TwitterClient | null = null
let connectionMode: ConnectionMode | null = null
let currentStream: TimelineStream = "home"
let officialToken: string | null = null
let officialUser: XApiUser | null = null
let sessionSource = "browser"
let authMode: "manual" | "browser" | null = null
let selectedCookieSource: CookieSource | null = null
let detectedBrowserOverride: BrowserSourceId[] | null = null
let cookieSessionBlocked = false
let timelineStreams = new Map<TimelineStream, TimelineStreamState>()
let generation = 0
let sessionEpoch = 0
let modalRoutes: ModalRoute[] = []
let modalReturnsToFeed = false
let browserRouteSources: CookieSource[] = []
let keymapDisposers: Array<() => void> = []
let activeKeymap: Keymap<Renderable, KeyEvent> | null = null
let xApiBaseUrl = X_API_BASE_URL
let currentView: AppView = "timeline"
let timelineReturnState: TimelineReturnState | null = null
let commentsRootTweet: TweetData | null = null
let commentsItems: CommentsItem[] = []
let commentTweetIds = new Set<string>()
let selectedCommentsIndex = -1
let commentsCursor: string | null = null
let commentsHasMore = false
let commentsLoading = false
let commentsPreparing = false
let commentsGeneration = 0
let commentsStateText: TextRenderable | null = null
let commentsScrollListener: (() => void) | null = null
let resizeListener: (() => void) | null = null
let imageOverlay: BoxRenderable | null = null
let imageViewport: BoxRenderable | null = null
let imageRenderable: ImageRenderable | null = null
let imageHeaderText: TextRenderable | null = null
let imageMetricsText: TextRenderable | null = null
let bindingsOverlay: BoxRenderable | null = null
let bindingsList: ScrollBoxRenderable | null = null
let bindingsContextText: TextRenderable | null = null
let bindingsCloseText: TextRenderable | null = null
let bindingsReturnFocus: Renderable | null = null
let imageTweet: TweetData | null = null
let imageItems: TweetMedia[] = []
let imageIndex = 0
let imageZoom = 1
let imagePanX = 0
let imagePanY = 0
let imageMessage = ""
let imageFallbackSource: string | null = null
let loadingActivityId = 0
let loadingActivities = new Map<number, LoadingActivity>()
let twitterClientFactory = (options: ConstructorParameters<typeof TwitterClient>[0]) => new TwitterClient(options)
let openExternalUrl = launchUrl

function sourceKey(cookie: Cookie, browser: BrowserName): string {
  return JSON.stringify([cookie.source?.browser ?? browser, cookie.source?.profile ?? "", cookie.source?.storeId ?? ""])
}

function preferXCookie(cookies: readonly Cookie[], name: string): Cookie | undefined {
  const matches = cookies.filter((cookie) => cookie.name === name && cookie.value.length > 0)
  return (
    matches.find((cookie) => cookie.domain === "x.com") ??
    matches.find((cookie) => cookie.domain?.endsWith(".x.com")) ??
    matches.find((cookie) => cookie.domain === "twitter.com") ??
    matches.find((cookie) => cookie.domain?.endsWith(".twitter.com")) ??
    matches[0]
  )
}

function formatCookieSource(cookie: Cookie, source: CookieSource): string {
  const profile = cookie.source?.profile?.split(/[\\/]/).filter(Boolean).at(-1)
  return [source.label, profile].filter(Boolean).join(" / ")
}

function detectCookieSources(): CookieSource[] {
  if (detectedBrowserOverride) {
    const selected = new Set(detectedBrowserOverride)
    return COOKIE_SOURCES.filter((source) => selected.has(source.id))
  }
  return COOKIE_SOURCES.filter((source) => source.detected())
}

async function findBrowserSession(source: CookieSource): Promise<BrowserSession> {
  const warnings: string[] = []
  const options: GetCookiesOptions = {
    url: "https://x.com/",
    origins: ["https://twitter.com/"],
    names: ["auth_token", "ct0"],
    browsers: [source.browser],
    mode: "merge",
    timeoutMs: 12_000,
  }
  source.configure(options)

  try {
    const result = await getCookies(options)
    warnings.push(...result.warnings.map((warning) => `${source.label}: ${warning}`))

    const profiles = new Map<string, Cookie[]>()
    for (const cookie of result.cookies) {
      const key = sourceKey(cookie, source.browser)
      const profileCookies = profiles.get(key) ?? []
      profileCookies.push(cookie)
      profiles.set(key, profileCookies)
    }

    for (const profileCookies of profiles.values()) {
      const authToken = preferXCookie(profileCookies, "auth_token")
      const ct0 = preferXCookie(profileCookies, "ct0")
      if (!authToken || !ct0) continue

      const sourceLabel = formatCookieSource(authToken, source)
      return {
        source: sourceLabel,
        warnings,
        cookies: {
          authToken: authToken.value,
          ct0: ct0.value,
          cookieHeader: toCookieHeader([authToken, ct0], { sort: "none" }),
          source: sourceLabel,
        },
      }
    }
  } catch (error) {
    warnings.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const detail = warnings.find((warning) => warning.trim().length > 0)
  throw new Error(
    detail
      ? `No complete X session was found in ${source.label}. ${detail}`
      : `No complete X session was found in ${source.label}.`,
  )
}

function parseManualSession(value: string): TwitterCookies {
  const cookieHeader = value.trim().replace(/^cookie:\s*/i, "")
  const pairs = new Map<string, string>()

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    const cookieValue = part.slice(separator + 1).trim()
    if (name && cookieValue) pairs.set(name, cookieValue)
  }

  const authToken = pairs.get("auth_token")
  const ct0 = pairs.get("ct0")
  if (!authToken || !ct0) {
    throw new Error("Paste both required cookies: auth_token=...; ct0=...")
  }

  return {
    authToken,
    ct0,
    cookieHeader: `auth_token=${authToken}; ct0=${ct0}`,
    source: "manual session",
  }
}

function apiErrorMessage(status: number, body: XApiResponse<unknown>): string {
  const detail = body.errors
    ?.map((error) => error.detail ?? error.message ?? error.title)
    .find((message): message is string => Boolean(message))
  return `X API HTTP ${status}${detail ? `: ${detail}` : ""}`
}

async function fetchXApi<T>(path: string, token: string): Promise<{ data: XApiResponse<T>; response: Response }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${xApiBaseUrl}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "OpenTUI-X-Demo/1.0",
      },
      signal: controller.signal,
    })
    const data = (await response.json().catch(() => ({}))) as XApiResponse<T>
    if (!response.ok) throw new Error(apiErrorMessage(response.status, data))
    return { data, response }
  } finally {
    clearTimeout(timeout)
  }
}

function requireApiData<T>(response: XApiResponse<T>, label: string): T {
  if (response.data !== undefined && response.data !== null) return response.data
  throw new Error(response.errors?.[0]?.detail ?? `X API did not return ${label}.`)
}

function mapOfficialMedia(post: XApiPost, mediaByKey: ReadonlyMap<string, XApiMedia>): TweetData["media"] {
  const result: NonNullable<TweetData["media"]> = []
  for (const key of post.attachments?.media_keys ?? []) {
    const media = mediaByKey.get(key)
    if (!media) continue
    const source = media.url ?? media.preview_image_url
    if (!source) continue
    result.push({
      type: media.type,
      url: source,
      previewUrl: media.preview_image_url,
      width: media.width,
      height: media.height,
      durationMs: media.duration_ms,
    })
  }
  return result.length > 0 ? result : undefined
}

function isXStatusUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return (url.hostname === "x.com" || url.hostname === "twitter.com") && /\/status\/\d+/.test(url.pathname)
  } catch {
    return false
  }
}

function officialWrapperUrls(post: XApiPost): string[] {
  const hasQuote = post.referenced_tweets?.some((item) => item.type === "quoted") === true
  return (post.entities?.urls ?? [])
    .filter(
      (entity) =>
        Boolean(entity.media_key) ||
        entity.display_url?.startsWith("pic.x.com/") === true ||
        (hasQuote && isXStatusUrl(entity.expanded_url)),
    )
    .map((entity) => entity.url)
}

function withRepostContext(original: TweetData, repostId: string, author: TweetData["author"]): TweetData {
  const normalized = original as AppTweetData
  normalized.timelineItemId = repostId
  normalized.repostedBy = { id: repostId, author }
  return normalized
}

function unwrapBirdRawTweet(value: BirdRawTweet | undefined): BirdRawTweet | undefined {
  let current = value
  while (current?.tweet) current = current.tweet
  return current
}

function unwrapBirdRawUser(value: BirdRawUser | undefined): BirdRawUser | undefined {
  let current = value
  while (current?.user) current = current.user
  return current
}

function prepareBirdRawTweet(
  value: BirdRawTweet | undefined,
  visited: ReadonlySet<string> = new Set(),
): BirdRawTweet | undefined {
  const raw = unwrapBirdRawTweet(value)
  if (!raw) return undefined
  if (raw.rest_id && visited.has(raw.rest_id)) return raw
  const nextVisited = raw.rest_id ? new Set(visited).add(raw.rest_id) : visited
  const user = unwrapBirdRawUser(raw.core?.user_results?.result)
  const quoted = prepareBirdRawTweet(raw.quoted_status_result?.result, nextVisited)
  return {
    ...raw,
    core: raw.core
      ? {
          ...raw.core,
          user_results: raw.core.user_results ? { ...raw.core.user_results, result: user } : undefined,
        }
      : undefined,
    quoted_status_result: raw.quoted_status_result
      ? { ...raw.quoted_status_result, result: quoted ?? raw.quoted_status_result.result }
      : undefined,
  }
}

function mapBirdOriginal(value: BirdRawTweet | undefined): TweetData | null {
  const raw = prepareBirdRawTweet(value)
  if (!raw) return null
  const mapped = mapTweetResult(raw as Parameters<typeof mapTweetResult>[0], { quoteDepth: 1, includeRaw: true })
  if (!mapped) return null
  return mapped
}

function normalizeCookieTweet(tweet: TweetData): TweetData {
  const raw = unwrapBirdRawTweet(tweet._raw as unknown as BirdRawTweet)
  const original = mapBirdOriginal(raw?.legacy?.retweeted_status_result?.result)
  return original ? withRepostContext(original, tweet.id, tweet.author) : tweet
}

function normalizeCookieTweets(tweets: readonly TweetData[]): TweetData[] {
  return tweets.map(normalizeCookieTweet)
}

function mapOfficialPosts(response: XApiResponse<XApiPost[]>, fallbackAuthor: XApiUser): TweetData[] {
  const posts = response.data ?? []
  const users = new Map((response.includes?.users ?? []).map((user) => [user.id, user]))
  const mediaByKey = new Map((response.includes?.media ?? []).map((media) => [media.media_key, media]))
  const includedTweets = new Map((response.includes?.tweets ?? []).map((tweet) => [tweet.id, tweet]))
  const mapPost = (post: XApiPost, authorFallback: XApiUser, visited: ReadonlySet<string>): TweetData => {
    const author = (post.author_id ? users.get(post.author_id) : undefined) ?? authorFallback
    const nextVisited = new Set(visited).add(post.id)
    const repostReference = post.referenced_tweets?.find((item) => item.type === "retweeted")
    const repostedPost =
      repostReference && !visited.has(repostReference.id) ? includedTweets.get(repostReference.id) : undefined
    const repostedAuthor = repostedPost?.author_id ? users.get(repostedPost.author_id) : undefined
    if (repostedPost && repostedAuthor) {
      const original = mapPost(repostedPost, repostedAuthor, nextVisited)
      return withRepostContext(original, post.id, {
        name: author.name,
        username: author.username,
        profileImageUrl: author.profile_image_url,
      } as TweetData["author"] & { profileImageUrl?: string })
    }

    const tweet: AppTweetData = {
      id: post.id,
      text: post.note_tweet?.text ?? post.text,
      author: {
        name: author.name,
        username: author.username,
        profileImageUrl: author.profile_image_url,
      } as TweetData["author"] & { profileImageUrl?: string },
      authorId: post.author_id,
      createdAt: post.created_at,
      replyCount: post.public_metrics?.reply_count,
      retweetCount: post.public_metrics?.retweet_count,
      likeCount: post.public_metrics?.like_count,
      media: mapOfficialMedia(post, mediaByKey),
      wrapperUrls: officialWrapperUrls(post),
    }
    const reference = post.referenced_tweets?.find((item) => item.type === "quoted")
    const quotedPost = reference && !visited.has(reference.id) ? includedTweets.get(reference.id) : undefined
    const quotedAuthor = quotedPost?.author_id ? users.get(quotedPost.author_id) : undefined
    if (quotedPost && quotedAuthor) tweet.quotedTweet = mapPost(quotedPost, quotedAuthor, nextVisited)
    return tweet
  }
  return posts.map((post) => mapPost(post, fallbackAuthor, new Set()))
}

async function fetchOfficialTimeline(
  paginationToken?: string,
  requestGeneration: number = generation,
  requestSessionEpoch: number = sessionEpoch,
): Promise<{
  tweets: TweetData[]
  nextToken: string | null
  rateLimitRemaining: string | null
}> {
  const token = officialToken
  if (!token) throw new Error("An OAuth 2.0 user access token is required.")

  if (!officialUser) {
    const { data } = await fetchXApi<XApiUser>("/2/users/me?user.fields=id,name,profile_image_url,username", token)
    if (requestGeneration !== generation || requestSessionEpoch !== sessionEpoch)
      throw new Error("Timeline request was cancelled.")
    officialUser = requireApiData(data, "the authenticated user")
  }

  const params = new URLSearchParams({
    max_results: String(PAGE_SIZE),
    "tweet.fields": "attachments,author_id,created_at,entities,note_tweet,public_metrics,referenced_tweets",
    expansions:
      "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id",
    "user.fields": "id,name,profile_image_url,username",
    "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width",
  })
  if (paginationToken) params.set("pagination_token", paginationToken)
  const { data, response } = await fetchXApi<XApiPost[]>(
    `/2/users/${encodeURIComponent(officialUser.id)}/timelines/reverse_chronological?${params.toString()}`,
    token,
  )
  const tweets = mapOfficialPosts(data, officialUser)

  return {
    tweets,
    nextToken: data.meta?.next_token ?? null,
    rateLimitRemaining: response.headers.get("x-rate-limit-remaining"),
  }
}

async function fetchOfficialComments(tweetId: string, paginationToken?: string): Promise<CommentsPage> {
  const token = officialToken
  if (!token || !officialUser) throw new Error("An active X API session is required.")

  const params = new URLSearchParams({
    query: `in_reply_to_tweet_id:${tweetId}`,
    sort_order: "recency",
    max_results: String(COMMENTS_PAGE_SIZE),
    "tweet.fields": "attachments,author_id,created_at,entities,note_tweet,public_metrics,referenced_tweets",
    expansions:
      "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id",
    "user.fields": "id,name,profile_image_url,username",
    "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width",
  })
  if (paginationToken) params.set("next_token", paginationToken)
  const { data } = await fetchXApi<XApiPost[]>(`/2/tweets/search/recent?${params.toString()}`, token)
  return {
    tweets: mapOfficialPosts(data, officialUser),
    nextCursor: data.meta?.next_token ?? null,
  }
}

async function fetchCommentsPage(tweetId: string, cursor?: string): Promise<CommentsPage> {
  if (connectionMode === "official") return fetchOfficialComments(tweetId, cursor)
  if (!client) throw new Error("An active browser session is required.")

  const result = await client.getRepliesPaged(tweetId, {
    maxPages: 1,
    cursor,
    pageDelayMs: 0,
    includeRaw: true,
  })
  if (!result.success) throw new Error(result.error)
  return { tweets: normalizeCookieTweets(result.tweets), nextCursor: result.nextCursor ?? null }
}

function compactCount(value: number | undefined): string {
  if (!value) return "0"
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
}

function relativeTime(value: string | undefined): string {
  if (!value) return ""
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ""

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m`
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h`
  if (elapsedSeconds < 604_800) return `${Math.floor(elapsedSeconds / 86_400)}d`

  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function formatKeyLabel(key: string): string {
  return (activeKeymap?.formatKey(key, { preferDisplay: true }) ?? key).toUpperCase()
}

function formatCommandKey(command: XtuiCommandName): string {
  const bindings = activeKeymap?.getCommandBindings({ visibility: "registered", commands: [command] }).get(command)
  return (
    formatCommandBindings(bindings, {
      keyNameAliases: { escape: "esc" },
      bindingSeparator: "/",
    }) ?? activeConfig.keybindings[command]
  ).toUpperCase()
}

function makeClickable(
  target: Renderable,
  action: () => void | boolean | Promise<void | boolean>,
  enabled: () => boolean = () => true,
  preventAutoFocus: boolean = true,
): void {
  target.onMouseDown = (event: MouseEvent) => {
    if (event.button !== MouseButton.LEFT || !enabled()) return
    event.stopPropagation()
    if (preventAutoFocus) event.preventDefault()
    currentRenderer?.setMousePointer("default")
    const result = action()
    if (!(result instanceof Promise) && !target.isDestroyed && enabled()) currentRenderer?.setMousePointer("pointer")
  }
  target.onMouseOver = () => {
    if (enabled()) currentRenderer?.setMousePointer("pointer")
  }
  target.onMouseOut = () => currentRenderer?.setMousePointer("default")
}

function clearChildren(container: BoxRenderable): void {
  for (const child of container.getChildren().toReversed()) child.destroyRecursively()
}

function updateHeader(): void {
  if (!headerText || !headerHomeText || !headerFollowingText || !headerActionText) return
  headerText.content = t`${bold(fg(COLORS.primary)("X"))}  `
  if (currentView === "comments") {
    const username = commentsRootTweet?.author.username
    headerHomeText.content = t`${underline(bold(fg(COLORS.primary)("COMMENTS")))}  `
    headerFollowingText.content = t`${fg(COLORS.secondary)(username ? `@${username}` : "")}  `
    headerActionText.content = t`${dim(fg(COLORS.secondary)(`${formatCommandKey("x.comments.back")} BACK · READ-ONLY`))}`
    return
  }
  headerHomeText.content =
    currentStream === "home" && connectionMode !== "official"
      ? t`${underline(bold(fg(COLORS.primary)("HOME")))}  `
      : t`${fg(COLORS.muted)("HOME")}  `
  headerFollowingText.content =
    currentStream === "following"
      ? t`${underline(bold(fg(COLORS.primary)("FOLLOWING")))}  `
      : t`${fg(COLORS.muted)("FOLLOWING")}  `
  headerActionText.content = t`${dim(fg(COLORS.secondary)(`${formatCommandKey("x.feed.switch-stream")} SWITCH · READ-ONLY`))}`
}

function addFooterItem(
  destination: BoxRenderable,
  id: string,
  key: string,
  label: string,
  color: string = COLORS.accent,
  action?: () => void | boolean | Promise<void | boolean>,
  compact: boolean = false,
): void {
  const item = new TextRenderable(destination.ctx, {
    id,
    content: compact
      ? t`${bold(fg(color)(`[${key}]`))} `
      : t`${bold(fg(color)(key))} ${fg(COLORS.secondary)(label)}   `,
    height: 1,
    wrapMode: "none",
    selectable: false,
    flexShrink: 0,
  })
  if (action) makeClickable(item, action)
  destination.add(item)
}

function updateFooter(): void {
  if (!footer) return
  clearChildren(footer)
  const actions = new BoxRenderable(footer.ctx, {
    id: "x-footer-actions",
    height: 1,
    flexDirection: "row",
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    overflow: "hidden",
  })
  footer.add(actions)
  const terminalWidth = currentRenderer?.width ?? 100
  const helpWidth = formatCommandKey("app.bindings").length + 2
  if (currentView === "comments") {
    const backKey = formatCommandKey("x.comments.back")
    const imageKey = formatCommandKey("x.comments.image")
    const compact = backKey.length + imageKey.length + helpWidth + 17 > terminalWidth
    const backFits = !compact || backKey.length + helpWidth + 3 <= terminalWidth
    const imageFits = !compact || backKey.length + imageKey.length + helpWidth + 6 <= terminalWidth
    if (backFits) addFooterItem(actions, "x-footer-back", backKey, "back", COLORS.accent, closeCommentsView, compact)
    if (imageFits) addFooterItem(actions, "x-footer-image", imageKey, "image", COLORS.accent, openImageView, compact)
  } else {
    const commentsKey = formatCommandKey("x.feed.comments")
    const imageKey = formatCommandKey("x.feed.image")
    const compact = commentsKey.length + imageKey.length + helpWidth + 21 > terminalWidth
    const commentsFits = !compact || commentsKey.length + helpWidth + 3 <= terminalWidth
    const imageFits = !compact || commentsKey.length + imageKey.length + helpWidth + 6 <= terminalWidth
    if (commentsFits)
      addFooterItem(actions, "x-footer-comments", commentsKey, "comments", COLORS.accent, openCommentsView, compact)
    if (imageFits) addFooterItem(actions, "x-footer-image", imageKey, "image", COLORS.accent, openImageView, compact)
  }

  const bindings = new TextRenderable(footer.ctx, {
    id: "x-footer-bindings",
    content: t`${bold(fg(COLORS.accent)(`[${formatCommandKey("app.bindings")}]`))}`,
    height: 1,
    marginLeft: "auto",
    flexShrink: 0,
    wrapMode: "none",
    selectable: false,
  })
  makeClickable(bindings, toggleBindingsOverlay)
  footer.add(bindings)
}

function timelineState(stream: TimelineStream = currentStream): TimelineStreamState | null {
  return timelineStreams.get(stream) ?? null
}

function updateActivityRow(): void {
  if (!activityRow || !activitySpinner || !activityLabel) return
  const active = [...loadingActivities.entries()].sort(
    ([leftId, left], [rightId, right]) => right.priority - left.priority || rightId - leftId,
  )
  const current = active[0]?.[1]
  activityRow.visible = current !== undefined
  activitySpinner.visible = current !== undefined
  activityLabel.content = current ? `${current.label}${active.length > 1 ? ` · ${active.length} operations` : ""}` : ""
}

function beginLoadingActivity(label: string, priority: number): LoadingActivityHandle {
  const id = ++loadingActivityId
  loadingActivities.set(id, { label, priority })
  updateActivityRow()
  let finished = false
  return {
    update(nextLabel) {
      if (finished) return
      const activity = loadingActivities.get(id)
      if (activity) activity.label = nextLabel
      updateActivityRow()
    },
    done() {
      if (finished) return
      finished = true
      loadingActivities.delete(id)
      updateActivityRow()
    },
  }
}

function resetPaginationState(state: TimelineStreamState): void {
  state.loadingMore = false
  state.hasMore = false
  state.officialNextToken = null
  state.cookieRequestedCount = PAGE_SIZE
}

function setTimelineStream(stream: TimelineStream): boolean {
  if (!connectionMode) return false
  if (connectionMode === "official") {
    currentStream = "following"
    updateHeader()
    if (stream === "home")
      setStatus("The documented X API exposes Following only; For You requires browser-session mode", COLORS.secondary)
    return true
  }

  if (currentStream === stream) return true
  const destination = timelineState(stream)
  if (!destination || !activateTimelineStream(stream)) return false
  if (destination.loaded) {
    setStatus(destination.status.message, destination.status.color)
    if (!destination.loading && Date.now() >= destination.nextRefreshAt) void refreshTimeline(destination, true)
  } else if (!destination.loading) {
    void refreshTimeline(destination)
  }
  return true
}

function switchTimelineStream(): boolean {
  return setTimelineStream(currentStream === "home" ? "following" : "home")
}

function postUrl(tweet: TweetData): string | null {
  if (!/^\d{1,19}$/.test(tweet.id) || !/^[A-Za-z0-9_]{1,15}$/.test(tweet.author.username)) return null
  return `https://x.com/${tweet.author.username}/status/${tweet.id}`
}

async function launchUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : "xdg-open"
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", '""', "/b", url] : [url]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with status ${code ?? "unknown"}`))
    })
  })
}

async function openPost(tweet: TweetData): Promise<void> {
  const url = postUrl(tweet)
  if (!url) throw new Error("The selected post has an invalid X URL.")
  await openExternalUrl(url)
}

function quitApplication(): void {
  currentRenderer?.destroy()
}

function toggleConsole(): void {
  currentRenderer?.console.toggle()
}

async function openTimelinePost(): Promise<boolean> {
  const state = timelineState()
  const tweet = state?.tweets[state.selectedIndex]
  if (!tweet) return false
  try {
    await openPost(tweet)
    setStatus("Opened the selected post on X", COLORS.green)
  } catch (error) {
    setStatus(`Could not open X: ${error instanceof Error ? error.message : String(error)}`, COLORS.error)
  }
  return true
}

function selectedCommentsTweet(): TweetData | null {
  return commentsItems[selectedCommentsIndex]?.tweet ?? null
}

async function openSelectedCommentsTweet(): Promise<boolean> {
  const tweet = selectedCommentsTweet()
  if (!tweet) return false
  try {
    await openPost(tweet)
    setStatus("Opened the selected post on X", COLORS.green)
  } catch (error) {
    setStatus(`Could not open X: ${error instanceof Error ? error.message : String(error)}`, COLORS.error)
  }
  return true
}

function openSessionFlowFromFeed(): boolean {
  const state = timelineState()
  if (state?.loading || state?.loadingMore) return false
  openConnectionFlow(true)
  return true
}

function cleanPostText(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim()
  if (normalized.length <= 900) return normalized
  return `${normalized.slice(0, 897).trimEnd()}...`
}

function postPreview(value: string, expanded: boolean): { text: string; isLong: boolean } {
  const normalized = value.replace(/\r\n/g, "\n").trim()
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  let preview = ""
  let count = 0
  let isLong = false

  for (const part of segmenter.segment(normalized)) {
    if (count >= POST_PREVIEW_GRAPHEMES) {
      isLong = true
      break
    }
    preview += part.segment
    count += 1
  }

  return {
    text: expanded || !isLong ? normalized : `${preview.trimEnd()}...`,
    isLong,
  }
}

function profileImageUrl(tweet: TweetData): string | undefined {
  const direct = (tweet.author as TweetData["author"] & { profileImageUrl?: string }).profileImageUrl
  if (direct) return direct
  const raw = tweet._raw as
    | {
        core?: {
          user_results?: {
            result?: {
              legacy?: { profile_image_url_https?: string }
              avatar?: { image_url?: string }
            }
          }
        }
      }
    | undefined
  const author = raw?.core?.user_results?.result
  return author?.legacy?.profile_image_url_https ?? author?.avatar?.image_url
}

function wrapperUrls(tweet: TweetData): string[] {
  const direct = (tweet as TweetData & { wrapperUrls?: string[] }).wrapperUrls ?? []
  const raw = tweet._raw as
    | {
        legacy?: {
          entities?: {
            urls?: XApiUrlEntity[]
            media?: Array<{ url?: string; expanded_url?: string }>
          }
        }
      }
    | undefined
  const hasQuote = tweet.quotedTweet !== undefined
  const rawUrls = (raw?.legacy?.entities?.urls ?? [])
    .filter(
      (entity) =>
        Boolean(entity.media_key) ||
        entity.display_url?.startsWith("pic.x.com/") === true ||
        (hasQuote && isXStatusUrl(entity.expanded_url)),
    )
    .map((entity) => entity.url)
  const mediaUrls = (raw?.legacy?.entities?.media ?? [])
    .filter((entity) => entity.url && (tweet.media?.length || isXStatusUrl(entity.expanded_url)))
    .map((entity) => entity.url!)
  return [...new Set([...direct, ...rawUrls, ...mediaUrls])]
}

function displayPostText(tweet: TweetData): string {
  let text = tweet.text
  for (const url of wrapperUrls(tweet)) text = text.replaceAll(url, "")
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function styledMentions(text: string, baseColor: string = COLORS.primary): StyledText {
  const chunks: TextChunk[] = []
  const mentionPattern = /@[A-Za-z0-9_]{1,15}/g
  let cursor = 0

  for (const match of text.matchAll(mentionPattern)) {
    const index = match.index
    const previous = index > 0 ? text[index - 1] : undefined
    if (previous && /[A-Za-z0-9_]/.test(previous)) continue
    if (index > cursor) chunks.push(fg(baseColor)(text.slice(cursor, index)))
    chunks.push(fg(COLORS.mention)(match[0]))
    cursor = index + match[0].length
  }

  if (cursor < text.length) chunks.push(fg(baseColor)(text.slice(cursor)))
  return new StyledText(chunks)
}

function postAuthorContent(tweet: TweetData) {
  const username = tweet.author.username || "unknown"
  const timestamp = relativeTime(tweet.createdAt)
  return t`${bold(fg(COLORS.primary)(tweet.author.name || username))} ${fg(COLORS.secondary)(`@${username}`)} ${fg(COLORS.muted)(timestamp ? `· ${timestamp}` : "")}`
}

function timelineItemId(tweet: TweetData): string {
  return (tweet as AppTweetData).timelineItemId ?? tweet.id
}

function addRepostContext(card: BoxRenderable, tweet: TweetData, postIndex: number, idPrefix: string): void {
  const context = (tweet as AppTweetData).repostedBy
  if (!context) return
  const name = context.author.name || context.author.username
  card.add(
    new TextRenderable(card.ctx, {
      id: `${idPrefix}-repost-${postIndex}`,
      content: t`${fg(COLORS.secondary)(`↻ ${name} reposted`)}`,
      width: "100%",
      height: 1,
      wrapMode: "none",
      selectable: false,
    }),
  )
}

function postBodyContent(tweet: TweetData, expanded: boolean = false) {
  const article = tweet.article?.title ? `\nARTICLE · ${tweet.article.title}` : ""
  const preview = postPreview(displayPostText(tweet), expanded)

  const chunks = [...styledMentions(preview.text).chunks]
  if (article) chunks.push(bold(fg(COLORS.amber)(article)))
  return new StyledText(chunks)
}

function postToggleContent(expanded: boolean): StyledText {
  return t`${bold(fg(COLORS.amber)(`[${formatCommandKey("x.feed.toggle-expanded")}] ${expanded ? "Show Less" : "Show More"}`))}`
}

function postMetricItems(tweet: TweetData) {
  return [
    { id: "replies", content: `↩ ${compactCount(tweet.replyCount)}`, color: COLORS.secondary, align: "flex-start" },
    { id: "likes", content: `♥ ${compactCount(tweet.likeCount)}`, color: COLORS.pink, align: "center" },
    { id: "reposts", content: `↻ ${compactCount(tweet.retweetCount)}`, color: COLORS.green, align: "flex-end" },
  ] as const
}

function addPostMetrics(
  card: BoxRenderable,
  tweet: TweetData,
  index: number,
  idPrefix: string = "x-post",
  onReplies?: () => void | boolean | Promise<boolean>,
): void {
  const row = new BoxRenderable(card.ctx, {
    id: `${idPrefix}-footer-${index}`,
    width: "100%",
    height: 1,
    marginTop: displayMediaItems(tweet).length > 0 || tweet.quotedTweet ? 0 : 1,
    flexDirection: "row",
    flexShrink: 0,
  })
  for (const metric of postMetricItems(tweet)) {
    const cell = new BoxRenderable(card.ctx, {
      id: `${idPrefix}-${metric.id}-${index}`,
      height: 1,
      flexDirection: "row",
      flexBasis: 0,
      flexGrow: 1,
      flexShrink: 1,
      alignItems: "center",
      justifyContent: metric.align,
    })
    if (metric.id === "replies" && onReplies) makeClickable(cell, onReplies)
    cell.add(
      new TextRenderable(card.ctx, {
        content: metric.content,
        fg: metric.color,
        height: 1,
        wrapMode: "none",
        selectable: false,
      }),
    )
    row.add(cell)
  }
  card.add(row)
}

function displayMediaItems(tweet: TweetData): TweetMedia[] {
  return (tweet.media ?? []).filter((media) => Boolean(media.previewUrl || media.url))
}

interface ImageFailureContext {
  kind: "avatar" | "media" | "quoted-avatar" | "quoted-media" | "viewer-media"
  postId: string
  mediaIndex?: number
  mediaType?: "photo" | "video" | "animated_gif"
  source: string
}

function sanitizedImageSource(source: string): string {
  if (source.startsWith("data:")) return "data:<redacted>"
  if (source.startsWith("blob:")) return "blob:<redacted>"
  if (!URL.canParse(source)) return source
  const url = new URL(source)
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.href
}

function sanitizedErrorText(value: string | undefined, source: string, sanitizedSource: string): string | undefined {
  if (!value) return undefined
  return source.length <= 2_048 ? value.replaceAll(source, sanitizedSource) : value
}

function reportImageFailure(context: ImageFailureContext, error: unknown): string {
  const sanitizedSource = sanitizedImageSource(context.source)
  const name = error instanceof Error ? error.name : typeof error
  const code = error instanceof ImageLoadError || error instanceof ImageError ? error.code : undefined
  const status = error instanceof ImageLoadError || error instanceof ImageError ? error.status : undefined
  const message = sanitizedErrorText(
    error instanceof Error ? error.message : String(error),
    context.source,
    sanitizedSource,
  )
  const stack = sanitizedErrorText(error instanceof Error ? error.stack : undefined, context.source, sanitizedSource)
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
  console.error("[x-demo] image load failed", {
    ...context,
    source: sanitizedSource,
    error: {
      name,
      code,
      status,
      message,
      cause: cause
        ? { name: cause.name, message: sanitizedErrorText(cause.message, context.source, sanitizedSource) }
        : undefined,
      stack,
    },
  })

  if (status !== undefined && error instanceof ImageLoadError) return `HTTP ${status}`
  if (code) return code.replaceAll("-", " ").toUpperCase()
  return name === "Error" ? "LOAD ERROR" : name.toUpperCase()
}

function viewableImages(tweet: TweetData): TweetMedia[] {
  return (tweet.media ?? []).filter((media) => media.type === "photo" && Boolean(media.url || media.previewUrl))
}

function selectedImageTweet(): TweetData | null {
  if (currentView === "comments") return selectedCommentsTweet()
  const state = timelineState()
  return state?.tweets[state.selectedIndex] ?? null
}

function updateImageViewText(): void {
  if (!imageTweet || !imageHeaderText || !imageMetricsText) return
  const position = imageItems.length > 1 ? `${imageIndex + 1}/${imageItems.length} · ` : ""
  const status = imageMessage ? ` · ${imageMessage}` : ""
  const panKeys = ["x.image.pan-left", "x.image.pan-down", "x.image.pan-up", "x.image.pan-right"]
    .map((command) => formatCommandKey(command as XtuiCommandName))
    .join("/")
  const metrics = postMetricItems(imageTweet)
  imageHeaderText.content = t`${bold(fg(COLORS.primary)(`IMAGE · ${position}${Math.round(imageZoom * 100)}%`))}${fg(COLORS.secondary)(`   ${formatCommandKey("x.image.previous")}/${formatCommandKey("x.image.next")} image   ${formatCommandKey("x.image.zoom-in")}/${formatCommandKey("x.image.zoom-out")} zoom   ${panKeys} pan   ${formatCommandKey("x.image.close")} back${status}`)}`
  imageMetricsText.content = t`${fg(metrics[0].color)(metrics[0].content)}   ${fg(metrics[1].color)(metrics[1].content)}   ${fg(metrics[2].color)(metrics[2].content)}`
}

function layoutImageView(width?: number, height?: number): void {
  if (!imageViewport || !imageRenderable) return
  const viewportWidth = Math.max(1, width ?? imageViewport.width)
  const viewportHeight = Math.max(1, height ?? imageViewport.height)
  const imageWidth = Math.max(1, Math.round(viewportWidth * imageZoom))
  const imageHeight = Math.max(1, Math.round(viewportHeight * imageZoom))
  const fitted = imageRenderable.image
    ? imageRenderable.getFittedSize(imageWidth, imageHeight)
    : { width: imageWidth, height: imageHeight }
  const fittedLeft = Math.round((viewportWidth - imageWidth) / 2) + Math.floor((imageWidth - fitted.width) / 2)
  const fittedTop = Math.round((viewportHeight - imageHeight) / 2) + Math.floor((imageHeight - fitted.height) / 2)
  const minPanX = fitted.width > viewportWidth ? viewportWidth - fitted.width - fittedLeft : 0
  const maxPanX = fitted.width > viewportWidth ? -fittedLeft : 0
  const minPanY = fitted.height > viewportHeight ? viewportHeight - fitted.height - fittedTop : 0
  const maxPanY = fitted.height > viewportHeight ? -fittedTop : 0
  imagePanX = Math.max(minPanX, Math.min(maxPanX, imagePanX))
  imagePanY = Math.max(minPanY, Math.min(maxPanY, imagePanY))
  imageRenderable.width = imageWidth
  imageRenderable.height = imageHeight
  imageRenderable.left = Math.round((viewportWidth - imageWidth) / 2 + imagePanX)
  imageRenderable.top = Math.round((viewportHeight - imageHeight) / 2 + imagePanY)
}

function loadImageViewItem(): void {
  if (!imageRenderable || !imageTweet) return
  const media = imageItems[imageIndex]
  const source = media?.url || media?.previewUrl
  if (!media || !source) return
  imageMessage = "LOADING"
  imageFallbackSource = media.previewUrl && media.previewUrl !== source ? media.previewUrl : null
  imageRenderable.source = undefined
  imageRenderable.source = source
  updateImageViewText()
}

function openImageView(tweet: TweetData | null = selectedImageTweet(), media?: TweetMedia): boolean {
  if (
    !tweet ||
    !root ||
    !imageOverlay ||
    !imageRenderable ||
    !currentRenderer ||
    imageOverlay.visible ||
    commentsPreparing
  )
    return false
  const items = viewableImages(tweet)
  if (items.length === 0) return false
  const nextIndex = media ? items.indexOf(media) : 0
  if (nextIndex < 0) return false

  imageTweet = tweet
  imageItems = items
  imageIndex = nextIndex
  imageZoom = 1
  imagePanX = 0
  imagePanY = 0
  layoutImageView(currentRenderer.width, Math.max(1, currentRenderer.height - IMAGE_CHROME_ROWS))
  loadImageViewItem()
  root.visible = false
  imageOverlay.visible = true
  imageOverlay.focus()
  return true
}

function closeImageView(): boolean {
  if (!imageOverlay?.visible || !root || !imageRenderable) return false
  imageRenderable.source = undefined
  root.visible = true
  imageOverlay.visible = false
  imageTweet = null
  imageItems = []
  imageMessage = ""
  imageFallbackSource = null
  if (currentView === "comments") commentsFeed?.focus()
  else feed?.focus()
  return true
}

function navigateImageView(delta: number): boolean {
  if (!imageOverlay?.visible || imageItems.length === 0) return false
  const nextIndex = Math.max(0, Math.min(imageItems.length - 1, imageIndex + delta))
  if (nextIndex === imageIndex) return true
  imageIndex = nextIndex
  imageZoom = 1
  imagePanX = 0
  imagePanY = 0
  layoutImageView()
  loadImageViewItem()
  return true
}

function zoomImageView(delta: number): boolean {
  if (!imageOverlay?.visible) return false
  imageZoom = Math.max(IMAGE_MIN_ZOOM, Math.min(IMAGE_MAX_ZOOM, imageZoom + delta))
  layoutImageView()
  updateImageViewText()
  return true
}

function panImageView(deltaX: number, deltaY: number): boolean {
  if (!imageOverlay?.visible) return false
  imagePanX += deltaX
  imagePanY += deltaY
  layoutImageView()
  return true
}

function createImageView(renderer: CliRenderer): BoxRenderable {
  imageOverlay = new BoxRenderable(renderer, {
    id: "x-image-view",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 200,
    backgroundColor: COLORS.background,
    flexDirection: "column",
    focusable: true,
    visible: false,
  })
  imageViewport = new BoxRenderable(renderer, {
    id: "x-image-viewport",
    width: "100%",
    flexGrow: 1,
    overflow: "hidden",
    onSizeChange() {
      layoutImageView()
    },
  })
  imageRenderable = new ImageRenderable(renderer, {
    id: "x-image-view-image",
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    fit: "fit",
    protocol: "auto",
    onLoad() {
      imageMessage = ""
      layoutImageView()
      updateImageViewText()
    },
    onError(error) {
      const media = imageItems[imageIndex]
      const viewer = imageRenderable
      const source = viewer?.source
      if (typeof source === "string" && media && imageTweet) {
        const reason = reportImageFailure(
          { kind: "viewer-media", postId: imageTweet.id, mediaIndex: imageIndex, mediaType: media.type, source },
          error,
        )
        if (imageFallbackSource && viewer) {
          const fallback = imageFallbackSource
          imageFallbackSource = null
          imageMessage = "LOADING PREVIEW"
          viewer.source = undefined
          viewer.source = fallback
          updateImageViewText()
          return
        }
        imageMessage = `UNAVAILABLE · ${reason}`
      } else imageMessage = "UNAVAILABLE"
      updateImageViewText()
    },
  })
  imageHeaderText = new TextRenderable(renderer, {
    id: "x-image-view-header",
    width: "100%",
    height: 1,
    flexShrink: 0,
    bg: "transparent",
    wrapMode: "none",
    selectable: false,
  })
  imageMetricsText = new TextRenderable(renderer, {
    id: "x-image-view-metrics",
    position: "absolute",
    left: 0,
    bottom: 0,
    width: "100%",
    height: 1,
    zIndex: 2,
    bg: "transparent",
    wrapMode: "none",
    selectable: false,
  })
  imageOverlay.add(imageHeaderText)
  imageViewport.add(imageRenderable)
  imageViewport.add(imageMetricsText)
  imageOverlay.add(imageViewport)
  return imageOverlay
}

function bindingsContext(): string {
  if (authOverlay?.visible) return "DIALOG"
  if (imageOverlay?.visible) return "IMAGE"
  return currentView === "comments" ? "COMMENTS" : "TIMELINE"
}

function closeBindingsOverlay(): boolean {
  if (!bindingsOverlay?.visible) return false
  bindingsOverlay.visible = false
  const returnFocus = bindingsReturnFocus
  bindingsReturnFocus = null
  if (returnFocus && !returnFocus.isDestroyed) returnFocus.focus()
  else if (imageOverlay?.visible) imageOverlay.focus()
  else if (authInput && !authInput.isDestroyed) authInput.focus()
  else if (authSelect && !authSelect.isDestroyed) authSelect.focus()
  else if (currentView === "comments") commentsFeed?.focus()
  else feed?.focus()
  return true
}

function openBindingsOverlay(): boolean {
  if (
    !bindingsOverlay ||
    !bindingsList ||
    !bindingsContextText ||
    !bindingsCloseText ||
    !activeKeymap ||
    !currentRenderer
  )
    return false
  const focused = currentRenderer.currentFocusedRenderable
  const keysByCommand = new Map<XtuiCommandName, string[]>()
  for (const active of activeKeymap.getActiveKeys()) {
    if (typeof active.command !== "string" || !(active.command in COMMAND_DETAILS)) continue
    const name = active.command as XtuiCommandName
    if (
      focused instanceof InputRenderable &&
      (name === "app.quit" || name === "app.console" || name === "x.modal.back")
    ) {
      const stroke = activeKeymap.parseKeySequence(activeConfig.keybindings[name])[0]!.stroke
      if (
        !stroke.ctrl &&
        !stroke.meta &&
        !stroke.super &&
        !stroke.hyper &&
        (stroke.name.length === 1 || stroke.name === "space")
      )
        continue
    }
    const display = (active.display === "escape" ? "esc" : active.display).toUpperCase()
    const keys = keysByCommand.get(name) ?? []
    if (!keys.includes(display)) keys.push(display)
    keysByCommand.set(name, keys)
  }
  const rows = [...keysByCommand.entries()]
    .map(([name, keys]) => ({ name, key: keys.join("/"), ...COMMAND_DETAILS[name] }))
    .sort((left, right) => left.order - right.order)

  bindingsReturnFocus = focused
  bindingsContextText.content = t`${bold(fg(COLORS.primary)(`ACTIVE · ${bindingsContext()}`))}  ${fg(COLORS.muted)(`${rows.length} commands`)}`
  bindingsCloseText.content = t`${bold(fg(COLORS.accent)(`${formatCommandKey("app.bindings")} / ESC`))} ${fg(COLORS.secondary)("close")}`
  clearChildren(bindingsList)
  bindingsList.scrollTop = 0
  const keyWidth = Math.min(18, Math.max(8, ...rows.map((row) => row.key.length + 2)))
  let category = ""
  for (const row of rows) {
    if (row.category !== category) {
      category = row.category
      bindingsList.add(
        new TextRenderable(bindingsList.ctx, {
          id: `x-bindings-category-${category.toLowerCase()}`,
          content: t`${bold(fg(COLORS.secondary)(category.toUpperCase()))}`,
          height: 1,
          marginTop: bindingsList.getChildren().length > 0 ? 1 : 0,
          wrapMode: "none",
          selectable: false,
        }),
      )
    }
    const item = new BoxRenderable(bindingsList.ctx, {
      id: `x-bindings-row-${row.name.replaceAll(".", "-")}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
    })
    item.add(
      new TextRenderable(bindingsList.ctx, {
        id: `x-bindings-key-${row.name.replaceAll(".", "-")}`,
        content: row.key,
        width: keyWidth,
        height: 1,
        fg: COLORS.accent,
        attributes: TextAttributes.BOLD,
        wrapMode: "none",
        selectable: false,
      }),
    )
    item.add(
      new TextRenderable(bindingsList.ctx, {
        content: row.title,
        height: 1,
        flexGrow: 1,
        fg: COLORS.primary,
        wrapMode: "none",
        selectable: false,
      }),
    )
    bindingsList.add(item)
  }

  bindingsOverlay.visible = true
  bindingsList.focus()
  return true
}

function toggleBindingsOverlay(): boolean {
  return bindingsOverlay?.visible ? closeBindingsOverlay() : openBindingsOverlay()
}

function createBindingsOverlay(renderer: CliRenderer): BoxRenderable {
  bindingsOverlay = new BoxRenderable(renderer, {
    id: "x-bindings-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 300,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#02050AF2",
    focusable: true,
    visible: false,
  })
  const modal = new BoxRenderable(renderer, {
    id: "x-bindings-modal",
    width: "86%",
    maxWidth: 72,
    height: "84%",
    maxHeight: 32,
    padding: 1,
    flexDirection: "column",
    border: true,
    borderStyle: "double",
    borderColor: COLORS.accent,
    backgroundColor: COLORS.panel,
    title: "BINDINGS",
    titleAlignment: "center",
  })
  bindingsContextText = new TextRenderable(renderer, {
    id: "x-bindings-context",
    content: "",
    width: "100%",
    height: 1,
    marginBottom: 1,
    wrapMode: "none",
    selectable: false,
  })
  bindingsList = new ScrollBoxRenderable(renderer, {
    id: "x-bindings-list",
    width: "100%",
    flexGrow: 1,
    scrollX: false,
    scrollY: true,
    viewportCulling: true,
    rootOptions: { backgroundColor: COLORS.panel },
    viewportOptions: { backgroundColor: COLORS.panel },
    contentOptions: { flexDirection: "column", backgroundColor: COLORS.panel },
  })
  bindingsList.verticalScrollBar.visible = activeConfig.scrollbar
  bindingsCloseText = new TextRenderable(renderer, {
    id: "x-bindings-close",
    content: "",
    width: "100%",
    height: 1,
    marginTop: 1,
    wrapMode: "none",
    selectable: false,
  })
  makeClickable(bindingsCloseText, closeBindingsOverlay)
  modal.add(bindingsContextText)
  modal.add(bindingsList)
  modal.add(bindingsCloseText)
  bindingsOverlay.add(modal)
  return bindingsOverlay
}

function addPostAuthor(card: BoxRenderable, tweet: TweetData, postIndex: number, idPrefix: string = "x-post"): void {
  const avatarUrl = profileImageUrl(tweet)
  const row = new BoxRenderable(card.ctx, {
    id: `${idPrefix}-author-${postIndex}`,
    width: "100%",
    height: avatarUrl ? 2 : 1,
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  })
  if (avatarUrl) {
    let avatar: ImageRenderable
    let failureReported = false
    const handleAvatarFailure = (error: unknown) => {
      if (failureReported) return
      failureReported = true
      reportImageFailure(
        {
          kind: idPrefix.includes("-quote") ? "quoted-avatar" : "avatar",
          postId: tweet.id,
          source: avatarUrl,
        },
        error,
      )
      avatar.visible = false
      row.height = 1
    }
    avatar = new ImageRenderable(card.ctx, {
      id: `${idPrefix}-avatar-${postIndex}`,
      source: avatarUrl,
      width: 4,
      height: 2,
      marginRight: 1,
      flexShrink: 0,
      fit: "cover",
      protocol: "auto",
      onError: handleAvatarFailure,
    })
    void avatar.loadPromise?.catch(handleAvatarFailure)
    row.add(avatar)
  }
  row.add(
    new TextRenderable(card.ctx, {
      id: `${idPrefix}-author-text-${postIndex}`,
      content: postAuthorContent(tweet),
      width: "100%",
      height: 1,
      flexShrink: 1,
      wrapMode: "none",
      selectable: true,
    }),
  )
  card.add(row)
}

function addPostMedia(
  card: BoxRenderable,
  tweet: TweetData,
  postIndex: number,
  idPrefix: string = "x-post-media",
  onOpen?: (tweet: TweetData, media: TweetMedia) => void,
): (() => void) | undefined {
  const mediaItems = displayMediaItems(tweet)
  if (mediaItems.length === 0) return undefined
  const visibleMedia = mediaItems.slice(0, 4)
  const isMosaic = visibleMedia.length > 1

  const mediaBox = new BoxRenderable(card.ctx, {
    id: `${idPrefix}-${postIndex}`,
    width: "100%",
    height: isMosaic ? MEDIA_MIN_ROWS : "auto",
    flexDirection: visibleMedia.length === 4 ? "column" : "row",
    flexShrink: 0,
    marginTop: 1,
    marginBottom: 1,
    gap: isMosaic ? 1 : 0,
    overflow: "hidden",
  })
  let firstImage: ImageRenderable | null = null
  let mosaicHeightUpdateQueued = false
  const horizontalGapContainers: BoxRenderable[] = []
  const singleHeightUpdates: Array<() => void> = []
  const updateMosaicHeight = () => {
    mosaicHeightUpdateQueued = false
    const mediaWidth = Math.max(0, card.width - MEDIA_CARD_HORIZONTAL_INSET)
    if (!isMosaic || !firstImage || mediaBox.isDestroyed || mediaWidth <= 0) return
    for (const container of horizontalGapContainers) container.columnGap = mediaWidth < 3 ? 0 : 1
    const nextHeight = Math.max(MEDIA_MIN_ROWS, Math.round((mediaWidth * 9) / (16 * firstImage.cellAspectRatio)))
    if (mediaBox.height !== nextHeight) mediaBox.height = nextHeight
  }
  const scheduleMosaicHeightUpdate = () => {
    if (!isMosaic || mosaicHeightUpdateQueued) return
    mosaicHeightUpdateQueued = true
    queueMicrotask(updateMosaicHeight)
  }
  mediaBox.onSizeChange = scheduleMosaicHeightUpdate

  const createTile = (media: TweetMedia, mediaIndex: number): BoxRenderable => {
    const source = media.previewUrl || media.url
    let sourceWidth = media.width ?? 0
    let sourceHeight = media.height ?? 0
    let heightUpdateQueued = false
    let image: ImageRenderable
    let failureReported = false

    const tile = new BoxRenderable(card.ctx, {
      id: `${idPrefix}-tile-${postIndex}-${mediaIndex}`,
      position: "relative",
      width: isMosaic ? "auto" : "100%",
      height: isMosaic ? "100%" : MEDIA_MIN_ROWS,
      flexBasis: isMosaic ? 0 : undefined,
      flexGrow: isMosaic ? 1 : 0,
      flexShrink: isMosaic ? 1 : 0,
      overflow: "hidden",
      backgroundColor: COLORS.background,
    })

    const mediaStatus = new TextRenderable(card.ctx, {
      id: `${idPrefix}-status-${postIndex}-${mediaIndex}`,
      content: `LOADING ${media.type === "photo" ? "IMAGE" : "VIDEO PREVIEW"}`,
      position: "absolute",
      left: 0,
      bottom: 0,
      width: "100%",
      height: 1,
      zIndex: 2,
      fg: COLORS.muted,
      bg: COLORS.panel,
      wrapMode: "none",
    })

    const updateHeight = () => {
      heightUpdateQueued = false
      const mediaWidth = Math.max(0, card.width - MEDIA_CARD_HORIZONTAL_INSET)
      if (isMosaic || image.isDestroyed || mediaWidth <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return
      const naturalRows = Math.round((mediaWidth * sourceHeight) / (sourceWidth * image.cellAspectRatio))
      const nextHeight = Math.max(MEDIA_MIN_ROWS, Math.min(MEDIA_MAX_ROWS, naturalRows))
      if (tile.height !== nextHeight) tile.height = nextHeight
    }
    const scheduleHeightUpdate = () => {
      if (heightUpdateQueued) return
      heightUpdateQueued = true
      queueMicrotask(updateHeight)
    }
    if (!isMosaic) singleHeightUpdates.push(scheduleHeightUpdate)
    const handleMediaFailure = (error: unknown) => {
      if (failureReported) return
      failureReported = true
      const reason = reportImageFailure(
        {
          kind: idPrefix.includes("quote-media") ? "quoted-media" : "media",
          postId: tweet.id,
          mediaIndex,
          mediaType: media.type,
          source,
        },
        error,
      )
      image.visible = false
      mediaStatus.content = `MEDIA UNAVAILABLE · ${reason}`
      mediaStatus.fg = COLORS.error
      mediaStatus.visible = true
    }

    image = new ImageRenderable(card.ctx, {
      id: `${idPrefix}-image-${postIndex}-${mediaIndex}`,
      source,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      fit: isMosaic ? "cover" : "fit",
      protocol: "auto",
      onSizeChange: isMosaic ? undefined : scheduleHeightUpdate,
      onLoad: (loaded) => {
        sourceWidth = loaded.width
        sourceHeight = loaded.height
        mediaStatus.content = media.type === "photo" ? "" : "VIDEO PREVIEW"
        mediaStatus.fg = COLORS.muted
        mediaStatus.visible = media.type !== "photo"
        if (isMosaic) scheduleMosaicHeightUpdate()
        else scheduleHeightUpdate()
      },
      onError: handleMediaFailure,
    })
    firstImage ??= image
    void image.loadPromise?.catch(handleMediaFailure)
    if (media.type === "photo" && onOpen) {
      if (isMosaic) makeClickable(tile, () => onOpen(tweet, media))
      else makeClickable(image, () => onOpen(tweet, media))
    }
    tile.add(image)
    tile.add(mediaStatus)
    return tile
  }

  const tiles = visibleMedia.map(createTile)
  if (visibleMedia.length <= 2) {
    if (isMosaic) horizontalGapContainers.push(mediaBox)
    for (const tile of tiles) mediaBox.add(tile)
  } else if (visibleMedia.length === 3) {
    horizontalGapContainers.push(mediaBox)
    tiles[1]!.height = "auto"
    tiles[2]!.height = "auto"
    const rightColumn = new BoxRenderable(card.ctx, {
      id: `${idPrefix}-column-${postIndex}`,
      height: "100%",
      flexBasis: 0,
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: "column",
      gap: 1,
    })
    rightColumn.add(tiles[1]!)
    rightColumn.add(tiles[2]!)
    mediaBox.add(tiles[0]!)
    mediaBox.add(rightColumn)
  } else {
    for (let rowIndex = 0; rowIndex < 2; rowIndex += 1) {
      const row = new BoxRenderable(card.ctx, {
        id: `${idPrefix}-row-${postIndex}-${rowIndex}`,
        width: "100%",
        flexBasis: 0,
        flexGrow: 1,
        flexShrink: 1,
        flexDirection: "row",
        gap: 1,
      })
      row.add(tiles[rowIndex * 2]!)
      row.add(tiles[rowIndex * 2 + 1]!)
      horizontalGapContainers.push(row)
      mediaBox.add(row)
    }
  }

  if (mediaItems.length > 4) {
    tiles[3]!.add(
      new TextRenderable(card.ctx, {
        id: `${idPrefix}-more-${postIndex}`,
        content: t`${bold(fg(COLORS.primary)(`+${mediaItems.length - 4}`))}`,
        position: "absolute",
        right: 0,
        bottom: 0,
        width: String(mediaItems.length - 4).length + 1,
        height: 1,
        zIndex: 3,
        bg: COLORS.panel,
        wrapMode: "none",
        selectable: false,
      }),
    )
  }

  card.add(mediaBox)
  scheduleMosaicHeightUpdate()
  return isMosaic ? scheduleMosaicHeightUpdate : () => singleHeightUpdates.forEach((schedule) => schedule())
}

function addQuotedPost(
  card: BoxRenderable,
  tweet: TweetData,
  postIndex: number,
  idPrefix: string = "x-post",
  onOpen?: (tweet: TweetData, media: TweetMedia) => void,
): void {
  const quoted = tweet.quotedTweet
  if (!quoted) return

  const quoteCard = new BoxRenderable(card.ctx, {
    id: `${idPrefix}-quote-${postIndex}`,
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    marginTop: displayMediaItems(tweet).length > 0 ? 0 : 1,
    marginBottom: 1,
    paddingLeft: 1,
    paddingRight: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  })
  addPostAuthor(quoteCard, quoted, postIndex, `${idPrefix}-quote`)
  quoteCard.add(
    new TextRenderable(card.ctx, {
      id: `${idPrefix}-quote-content-${postIndex}`,
      content: styledMentions(cleanPostText(displayPostText(quoted)), COLORS.secondary),
      width: "100%",
      marginTop: 1,
      wrapMode: "word",
      selectable: true,
    }),
  )
  addPostMedia(quoteCard, quoted, postIndex, `${idPrefix}-quote-media`, onOpen)
  card.add(quoteCard)
}

function clearFeed(state: TimelineStreamState, clearExpanded: boolean = true): void {
  for (const card of state.cards) card.destroyRecursively()
  state.cards = []
  state.tweets = []
  state.tweetIds.clear()
  state.postBodies.clear()
  state.postToggles.clear()
  if (clearExpanded) state.expandedPostIds.clear()
  state.selectedIndex = -1
  state.emptyState?.destroyRecursively()
  state.emptyState = null
}

function showEmptyState(
  state: TimelineStreamState,
  title: string,
  message: string,
  tone: "loading" | "error" = "loading",
): void {
  clearFeed(state)

  state.emptyState = new BoxRenderable(state.feed.ctx, {
    id: "x-empty-state",
    width: "100%",
    padding: 2,
    marginTop: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: tone === "error" ? COLORS.error : COLORS.borderActive,
    backgroundColor: COLORS.card,
    flexShrink: 0,
  })
  state.emptyState.add(
    new TextRenderable(state.feed.ctx, {
      content: t`${bold(fg(tone === "error" ? COLORS.error : COLORS.accent)(title))}

${fg(COLORS.secondary)(message)}`,
      wrapMode: "word",
    }),
  )
  state.feed.add(state.emptyState)
}

function selectPost(state: TimelineStreamState, nextIndex: number, loadMore: boolean = true): void {
  if (state.cards.length === 0) return
  state.selectedIndex = Math.max(0, Math.min(nextIndex, state.cards.length - 1))

  for (const [index, card] of state.cards.entries()) {
    const selected = index === state.selectedIndex
    card.backgroundColor = selected ? COLORS.cardActive : COLORS.card
    card.borderColor = selected ? COLORS.borderActive : COLORS.border
  }

  const selectedCard = state.cards[state.selectedIndex]
  if (selectedCard) state.feed.scrollChildIntoView(selectedCard.id)
  if (loadMore && state.selectedIndex >= state.tweets.length - 5) void loadMoreTimeline(state)
}

function togglePostExpansion(state: TimelineStreamState, index: number): boolean {
  const tweet = state.tweets[index]
  if (!tweet || !postPreview(displayPostText(tweet), false).isLong) return false
  const itemId = timelineItemId(tweet)
  const body = state.postBodies.get(itemId)
  const toggle = state.postToggles.get(itemId)
  if (!body || !toggle) return false

  const expanded = !state.expandedPostIds.has(itemId)
  if (expanded) state.expandedPostIds.add(itemId)
  else state.expandedPostIds.delete(itemId)
  body.content = postBodyContent(tweet, expanded)
  toggle.content = postToggleContent(expanded)
  const currentGeneration = generation
  queueMicrotask(() => {
    if (currentGeneration === generation && currentView === "timeline" && currentStream === state.stream)
      state.feed.scrollChildIntoView(`x-post-${itemId}`)
  })
  return true
}

function toggleSelectedPostExpansion(): boolean {
  const state = timelineState()
  return state ? togglePostExpansion(state, state.selectedIndex) : false
}

function createPostCard(state: TimelineStreamState, tweet: TweetData, index: number): BoxRenderable {
  const itemId = timelineItemId(tweet)
  let scheduleMediaLayout: (() => void) | undefined
  let mediaLayoutWidth = -1
  const card = new BoxRenderable(state.feed.ctx, {
    id: `x-post-${itemId}`,
    width: "100%",
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.card,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    flexShrink: 0,
  })
  card.onSizeChange = () => {
    if (card.width === mediaLayoutWidth) return
    mediaLayoutWidth = card.width
    scheduleMediaLayout?.()
  }
  makeClickable(
    card,
    () => selectPost(state, index),
    () => currentStream === state.stream,
    false,
  )
  addRepostContext(card, tweet, index, "x-post")
  addPostAuthor(card, tweet, index)
  const body = new TextRenderable(state.feed.ctx, {
    id: `x-post-content-${index}`,
    content: postBodyContent(tweet, state.expandedPostIds.has(itemId)),
    width: "100%",
    marginTop: 1,
    wrapMode: "word",
    selectable: true,
  })
  state.postBodies.set(itemId, body)
  card.add(body)
  if (postPreview(displayPostText(tweet), false).isLong) {
    const toggle = new TextRenderable(state.feed.ctx, {
      id: `x-post-toggle-${itemId}`,
      content: postToggleContent(state.expandedPostIds.has(itemId)),
      marginTop: 1,
      wrapMode: "none",
      selectable: false,
    })
    makeClickable(
      toggle,
      () => {
        selectPost(state, index, false)
        return togglePostExpansion(state, index)
      },
      () => currentStream === state.stream,
    )
    state.postToggles.set(itemId, toggle)
    card.add(toggle)
  }
  const openMedia = (mediaTweet: TweetData, media: TweetMedia) => {
    selectPost(state, index, false)
    openImageView(mediaTweet, media)
  }
  scheduleMediaLayout = addPostMedia(card, tweet, index, "x-post-media", openMedia)
  addQuotedPost(card, tweet, index, "x-post", openMedia)
  addPostMetrics(card, tweet, index, "x-post", () => {
    if (currentStream !== state.stream) return false
    selectPost(state, index, false)
    return openCommentsView()
  })
  return card
}

function createCommentsPostCard(
  destination: ScrollBoxRenderable,
  tweet: TweetData,
  index: number,
  idPrefix: "x-comments-root" | "x-comment",
): BoxRenderable {
  const isRoot = idPrefix === "x-comments-root"
  const card = new BoxRenderable(destination.ctx, {
    id: `${idPrefix}-${tweet.id}`,
    width: "100%",
    paddingLeft: 1,
    paddingRight: 1,
    marginBottom: isRoot ? 1 : 0,
    backgroundColor: COLORS.card,
    border: true,
    borderStyle: isRoot ? "double" : "rounded",
    borderColor: COLORS.border,
    title: isRoot ? "POST" : undefined,
    titleColor: isRoot ? COLORS.accent : undefined,
    flexShrink: 0,
  })
  addRepostContext(card, tweet, index, idPrefix)
  addPostAuthor(card, tweet, index, idPrefix)
  card.add(
    new TextRenderable(destination.ctx, {
      id: `${idPrefix}-content-${index}`,
      content: postBodyContent(tweet, true),
      width: "100%",
      marginTop: 1,
      wrapMode: "word",
      selectable: true,
    }),
  )
  const openMedia = (mediaTweet: TweetData, media: TweetMedia) => {
    selectCommentsItem(index, false)
    openImageView(mediaTweet, media)
  }
  addPostMedia(card, tweet, index, `${idPrefix}-media`, openMedia)
  addQuotedPost(card, tweet, index, idPrefix, openMedia)
  addPostMetrics(card, tweet, index, idPrefix)
  makeClickable(card, () => selectCommentsItem(index), undefined, false)
  return card
}

function appendTweets(state: TimelineStreamState, tweets: readonly TweetData[]): number {
  let added = 0
  for (const tweet of tweets) {
    const itemId = timelineItemId(tweet)
    if (state.tweetIds.has(itemId)) continue
    const index = state.tweets.length
    const card = createPostCard(state, tweet, index)
    state.tweetIds.add(itemId)
    state.tweets.push(tweet)
    state.cards.push(card)
    state.feed.add(card)
    added += 1
  }
  return added
}

function showTweets(state: TimelineStreamState, tweets: readonly TweetData[], preserveViewport: boolean = false): void {
  const previousSelectedIndex = state.selectedIndex
  const selectedTweet = preserveViewport ? state.tweets[state.selectedIndex] : undefined
  const selectedItemId = selectedTweet ? timelineItemId(selectedTweet) : null
  const selectedOffset = state.cards[state.selectedIndex]
    ? state.cards[state.selectedIndex]!.screenY - state.feed.viewport.screenY
    : 0
  clearFeed(state, !preserveViewport)
  appendTweets(state, tweets)
  const matchingIndex = selectedItemId
    ? state.tweets.findIndex((tweet) => timelineItemId(tweet) === selectedItemId)
    : -1
  const selectedIndex =
    matchingIndex >= 0 ? matchingIndex : Math.min(Math.max(previousSelectedIndex, 0), state.cards.length - 1)
  if (state.cards.length > 0) selectPost(state, selectedIndex, false)
  if (preserveViewport && matchingIndex >= 0) {
    queueMicrotask(() => {
      const selectedCard = state.cards[state.selectedIndex]
      if (!state.feed.isDestroyed && selectedCard)
        state.feed.scrollTop += selectedCard.screenY - state.feed.viewport.screenY - selectedOffset
    })
  }
}

function setStatus(message: string, color: string): void {
  if (!statusText) return
  if (currentView === "timeline") {
    const state = timelineState()
    if (state) state.status = { message, color }
  }
  statusText.content = t`${bold(fg(color)("●"))} ${fg(COLORS.secondary)(message)}`
}

function setTimelineStatus(state: TimelineStreamState, message: string, color: string): void {
  state.status = { message, color }
  if (currentView === "timeline" && currentStream === state.stream) setStatus(message, color)
}

function clearCommentsContent(): void {
  commentsItems = []
  commentTweetIds.clear()
  selectedCommentsIndex = -1
  commentsStateText?.destroyRecursively()
  commentsStateText = null
  if (!commentsFeed) return
  for (const child of commentsFeed.getChildren().toReversed()) child.destroyRecursively()
}

function setCommentsState(message: string, color: string = COLORS.secondary): void {
  if (!commentsStateText) return
  commentsStateText.content = t`${bold(fg(color)(message))}`
}

function commentCount(): number {
  return commentsItems.length > 0 && commentsItems[0]?.kind === "root" ? commentsItems.length - 1 : commentsItems.length
}

function appendComments(tweets: readonly TweetData[]): number {
  if (!commentsFeed || !commentsStateText) return 0
  let added = 0
  for (const tweet of tweets) {
    if (commentTweetIds.has(tweet.id)) continue
    const index = commentsItems.length
    const card = createCommentsPostCard(commentsFeed, tweet, index, "x-comment")
    commentTweetIds.add(tweet.id)
    commentsItems.push({ kind: "comment", tweet, card })
    commentsFeed.insertBefore(card, commentsStateText)
    added += 1
  }
  return added
}

function selectCommentsItem(nextIndex: number, scrollIntoView: boolean = true): void {
  if (!commentsFeed || commentsItems.length === 0) return
  selectedCommentsIndex = Math.max(0, Math.min(nextIndex, commentsItems.length - 1))
  for (const [index, item] of commentsItems.entries()) {
    const selected = index === selectedCommentsIndex
    item.card.backgroundColor = selected ? COLORS.cardActive : COLORS.card
    item.card.borderColor = selected ? COLORS.borderActive : COLORS.border
    if (item.kind === "root") {
      item.card.title = selected ? "SELECTED POST" : "POST"
      item.card.titleColor = selected ? COLORS.accent : COLORS.secondary
    }
  }

  const selectedCard = commentsItems[selectedCommentsIndex]?.card
  if (scrollIntoView && selectedCard) commentsFeed.scrollChildIntoView(selectedCard.id)
  if (selectedCommentsIndex > 0 && selectedCommentsIndex >= commentsItems.length - 5) void loadCommentsPage()
}

function closeCommentsView(): boolean {
  if (currentView !== "comments" || !commentsFeed) return false
  commentsGeneration += 1
  commentsLoading = false
  commentsPreparing = false
  commentsHasMore = false
  const state = timelineState(timelineReturnState?.stream ?? currentStream)
  if (!state) return false
  currentStream = state.stream
  feed = state.feed
  state.feed.visible = true
  currentView = "timeline"
  commentsRootTweet = null
  updateHeader()
  updateFooter()
  setStatus(state.status.message, state.status.color)
  timelineReturnState = null
  state.feed.focus()
  clearCommentsContent()
  return true
}

async function openCommentsView(): Promise<boolean> {
  const state = timelineState()
  if (
    currentView !== "timeline" ||
    !feed ||
    !commentsFeed ||
    !statusText ||
    !connectionMode ||
    !currentRenderer ||
    commentsPreparing ||
    !state ||
    state.loading ||
    state.loadingMore
  )
    return false
  const tweet = state.tweets[state.selectedIndex]
  if (!tweet) return false
  const renderer = currentRenderer
  const activity = beginLoadingActivity("Preparing comments", 70)

  commentsGeneration += 1
  const requestGeneration = commentsGeneration
  commentsPreparing = true
  commentsLoading = false
  commentsCursor = null
  commentsHasMore = true
  commentsRootTweet = tweet
  timelineReturnState = { stream: state.stream }
  clearCommentsContent()
  commentsFeed.scrollTop = 0
  const rootCard = createCommentsPostCard(commentsFeed, tweet, 0, "x-comments-root")
  commentsFeed.add(rootCard)
  commentsItems.push({ kind: "root", tweet, card: rootCard })
  commentTweetIds.add(tweet.id)
  selectCommentsItem(0, false)
  commentsFeed.add(
    new TextRenderable(commentsFeed.ctx, {
      id: "x-comments-heading",
      content: t`${bold(fg(COLORS.primary)("COMMENTS"))}  ${dim(fg(COLORS.secondary)("DIRECT REPLIES"))}`,
      height: 1,
      marginBottom: 1,
      wrapMode: "none",
    }),
  )
  commentsStateText = new TextRenderable(commentsFeed.ctx, {
    id: "x-comments-state",
    content: "",
    marginTop: 1,
    marginBottom: 1,
    wrapMode: "word",
  })
  commentsFeed.add(commentsStateText)
  setCommentsState("LOADING COMMENTS...", COLORS.amber)

  // Media sizing needs an attached layout pass; keep that pass behind the timeline.
  await renderer.idle()
  if (
    requestGeneration !== commentsGeneration ||
    currentRenderer !== renderer ||
    renderer.isDestroyed ||
    currentView !== "timeline" ||
    currentStream !== state.stream ||
    !connectionMode ||
    !feed ||
    !commentsFeed
  ) {
    if (requestGeneration === commentsGeneration) commentsPreparing = false
    activity.done()
    return false
  }

  state.feed.visible = false
  currentView = "comments"
  updateHeader()
  updateFooter()
  commentsFeed.focus()
  setStatus("Loading direct replies...", COLORS.amber)
  commentsPreparing = false
  activity.done()
  void loadCommentsPage()
  return true
}

function destroyAuthOverlay(): void {
  authInput?.setText("")
  authInput?.blur()
  authSelect?.blur()
  authOverlay?.destroyRecursively()
  authOverlay = null
  authInput = null
  authSelect = null
  authHint = null
}

function closeModalFlow(): void {
  modalRoutes = []
  browserRouteSources = []
  modalReturnsToFeed = false
  destroyAuthOverlay()
  feed?.focus()
}

function renderModalRoute(): void {
  if (!currentRenderer) return
  const route = modalRoutes.at(-1)
  if (!route) {
    closeModalFlow()
    return
  }

  switch (route) {
    case "connection":
      showConnectionPicker(currentRenderer)
      break
    case "official-token":
      showOfficialTokenOverlay(currentRenderer)
      break
    case "cookie-risk":
      showCookieRiskOverlay(currentRenderer)
      break
    case "cookie-auth":
      showCookieAuthOverlay(currentRenderer)
      break
    case "browser":
      showBrowserPicker(currentRenderer, browserRouteSources)
      break
  }
}

function pushModalRoute(route: ModalRoute): void {
  modalRoutes.push(route)
  renderModalRoute()
}

function canPopModalRoute(): boolean {
  return modalRoutes.length > 1 || (modalRoutes.length === 1 && modalReturnsToFeed)
}

function popModalRoute(): boolean {
  if (!canPopModalRoute()) return false
  modalRoutes.pop()
  renderModalRoute()
  return true
}

function openConnectionFlow(returnToFeed: boolean): void {
  modalRoutes = ["connection"]
  browserRouteSources = []
  modalReturnsToFeed = returnToFeed
  renderModalRoute()
}

function createHintRow(renderer: CliRenderer, id: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    width: "100%",
    marginTop: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    flexShrink: 0,
  })
}

function addHintSegment(
  row: BoxRenderable,
  id: string,
  content: StyledText | string,
  action?: () => void | boolean,
  flexGrow: number = 0,
): TextRenderable {
  const segment = new TextRenderable(row.ctx, {
    id,
    content,
    height: flexGrow > 0 ? "auto" : 1,
    wrapMode: flexGrow > 0 ? "word" : "none",
    selectable: false,
    flexGrow,
    flexShrink: flexGrow > 0 ? 1 : 0,
  })
  if (action) makeClickable(segment, action)
  row.add(segment)
  return segment
}

function addSelectHint(
  modal: BoxRenderable,
  renderer: CliRenderer,
  id: string,
  confirmLabel: string,
  backAction?: () => boolean,
): void {
  const row = createHintRow(renderer, id)
  addHintSegment(row, `${id}-choose`, t`${bold(fg(COLORS.accent)("UP/DOWN"))} ${fg(COLORS.secondary)("choose")}   `)
  addHintSegment(
    row,
    `${id}-confirm`,
    t`${bold(fg(COLORS.green)(formatKeyLabel("return")))} ${fg(COLORS.secondary)(confirmLabel)}   `,
    () => authSelect?.selectCurrent(),
  )
  if (backAction) {
    addHintSegment(
      row,
      `${id}-back`,
      t`${bold(fg(COLORS.secondary)(formatCommandKey("x.modal.back")))} ${fg(COLORS.secondary)("back")}   `,
      backAction,
    )
  }
  addHintSegment(
    row,
    `${id}-quit`,
    t`${bold(fg(COLORS.error)(formatCommandKey("app.quit")))} ${fg(COLORS.secondary)("quit")}`,
    quitApplication,
  )
  modal.add(row)
}

function addInputHint(
  modal: BoxRenderable,
  renderer: CliRenderer,
  id: string,
  initialStatus: StyledText,
  submitLabel: string,
): TextRenderable {
  const row = createHintRow(renderer, id)
  const status = addHintSegment(row, `${id}-status`, initialStatus, undefined, 1)
  addHintSegment(
    row,
    `${id}-submit`,
    t`${bold(fg(COLORS.green)(formatKeyLabel("return")))} ${fg(COLORS.secondary)(submitLabel)}   `,
    () => authInput?.submit(),
  )
  addHintSegment(
    row,
    `${id}-back`,
    t`${bold(fg(COLORS.secondary)(formatCommandKey("x.modal.back")))} ${fg(COLORS.secondary)("back")}   `,
    popModalRoute,
  )
  addHintSegment(
    row,
    `${id}-quit`,
    t`${bold(fg(COLORS.error)(formatCommandKey("app.quit")))} ${fg(COLORS.secondary)("quit")}`,
    quitApplication,
  )
  modal.add(row)
  return status
}

function enableSelectMouse(select: SelectRenderable): void {
  select.onMouseDown = (event: MouseEvent) => {
    if (event.button !== MouseButton.LEFT) return
    const index = Math.floor((event.y - select.y) / 2)
    if (index < 0 || index >= select.options.length) return
    event.stopPropagation()
    event.preventDefault()
    currentRenderer?.setMousePointer("default")
    select.setSelectedIndex(index)
    select.selectCurrent()
  }
  select.onMouseOver = () => currentRenderer?.setMousePointer("pointer")
  select.onMouseOut = () => currentRenderer?.setMousePointer("default")
}

function selectCookieSource(source: CookieSource): void {
  rememberBrowserSource(source.id)
  connectionMode = "cookie"
  selectedCookieSource = source
  client = null
  officialToken = null
  officialUser = null
  sessionSource = source.label
  authMode = "browser"
  cookieSessionBlocked = false
  clearTimelineCaches()
  const state = activateTimelineStream("home")
  closeModalFlow()
  void refreshTimeline(state)
}

function showBrowserPicker(renderer: CliRenderer, sources: CookieSource[]): void {
  destroyAuthOverlay()

  authOverlay = new BoxRenderable(renderer, {
    id: "x-browser-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#02050AE6",
  })

  const modal = new BoxRenderable(renderer, {
    id: "x-browser-modal",
    width: "86%",
    maxWidth: 68,
    height: "auto",
    padding: 2,
    flexDirection: "column",
    border: true,
    borderStyle: "double",
    borderColor: COLORS.accent,
    backgroundColor: COLORS.panel,
    title: "CHOOSE A BROWSER",
    titleAlignment: "center",
  })
  modal.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.primary)("Multiple local cookie stores were detected."))}
${fg(COLORS.secondary)("Choose the browser that contains the X session you want to use.")}`,
      width: "100%",
      wrapMode: "word",
    }),
  )

  const selectBox = new BoxRenderable(renderer, {
    id: "x-browser-select-box",
    width: "100%",
    height: sources.length * 2 + 2,
    marginTop: 1,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.borderActive,
    backgroundColor: COLORS.card,
  })
  const options: SelectOption[] = sources.map((source) => ({
    name: source.label,
    description: source.description,
    value: source,
  }))
  authSelect = new SelectRenderable(renderer, {
    id: "x-browser-select",
    width: "100%",
    height: sources.length * 2,
    options,
    selectedIndex: 0,
    backgroundColor: COLORS.card,
    focusedBackgroundColor: COLORS.card,
    textColor: COLORS.primary,
    focusedTextColor: COLORS.primary,
    selectedBackgroundColor: COLORS.selectedBackground,
    selectedTextColor: COLORS.selectedText,
    descriptionColor: COLORS.muted,
    selectedDescriptionColor: COLORS.selectedDescription,
    showDescription: true,
    showSelectionIndicator: true,
    wrapSelection: true,
    itemSpacing: 0,
  })
  enableSelectMouse(authSelect)
  authSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    selectCookieSource(option.value as CookieSource)
  })
  selectBox.add(authSelect)
  modal.add(selectBox)
  addSelectHint(modal, renderer, "x-browser-hint", "continue", popModalRoute)

  authOverlay.add(modal)
  renderer.root.add(authOverlay)
  authSelect.focus()
}

function submitOfficialToken(value: string): void {
  const token = value.trim().replace(/^bearer\s+/i, "")
  if (!token) {
    if (authHint) {
      authHint.content = t`${bold(fg(COLORS.error)("TOKEN REQUIRED"))} ${fg(COLORS.secondary)(
        "Provide an OAuth 2.0 user access token, or go back and choose browser cookies.",
      )}`
    }
    return
  }

  rememberBrowserSource(null)
  officialToken = token
  officialUser = null
  connectionMode = "official"
  client = null
  selectedCookieSource = null
  sessionSource = "X API v2"
  cookieSessionBlocked = false
  clearTimelineCaches()
  const state = activateTimelineStream("following")
  closeModalFlow()
  void refreshTimeline(state)
}

function showOfficialTokenOverlay(renderer: CliRenderer): void {
  destroyAuthOverlay()
  authOverlay = new BoxRenderable(renderer, {
    id: "x-official-token-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#02050AE6",
  })

  const modal = new BoxRenderable(renderer, {
    id: "x-official-token-modal",
    width: "86%",
    maxWidth: 74,
    height: "auto",
    padding: 2,
    flexDirection: "column",
    border: true,
    borderStyle: "double",
    borderColor: COLORS.green,
    backgroundColor: COLORS.panel,
    title: "OFFICIAL X API",
    titleAlignment: "center",
  })
  modal.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.green)("Recommended · documented API access"))}
${fg(COLORS.secondary)("Enter an OAuth 2.0 user access token with tweet.read and users.read scopes.")}
${fg(COLORS.muted)("This loads the reverse-chronological home timeline, not the web For You feed.")}

${fg(COLORS.muted)("The token is concealed, kept in memory only, and sent only to api.x.com.")}`,
      width: "100%",
      wrapMode: "word",
    }),
  )

  const inputBox = new BoxRenderable(renderer, {
    id: "x-official-token-input-box",
    width: "100%",
    height: 3,
    marginTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.green,
    backgroundColor: COLORS.card,
  })
  authInput = new InputRenderable(renderer, {
    id: "x-official-token-input",
    width: "100%",
    maxLength: 4_096,
    textColor: COLORS.card,
    focusedTextColor: COLORS.card,
    backgroundColor: COLORS.card,
    focusedBackgroundColor: COLORS.card,
    cursorColor: COLORS.green,
    attributes: TextAttributes.HIDDEN,
  })
  makeClickable(inputBox, () => authInput?.focus(), undefined, false)
  inputBox.add(authInput)
  modal.add(inputBox)

  authHint = addInputHint(modal, renderer, "x-official-token-hint", t`${fg(COLORS.muted)("Paste token")}`, "continue")
  authInput.on(InputRenderableEvents.INPUT, (inputValue: string) => {
    if (!authHint) return
    authHint.content = inputValue
      ? t`${fg(COLORS.green)(`TOKEN · ${inputValue.length} CHARS`)}`
      : t`${fg(COLORS.muted)("Paste token")}`
  })
  authInput.on(InputRenderableEvents.ENTER, submitOfficialToken)

  authOverlay.add(modal)
  renderer.root.add(authOverlay)
  authInput.focus()
}

function showCookieRiskOverlay(renderer: CliRenderer): void {
  destroyAuthOverlay()
  authOverlay = new BoxRenderable(renderer, {
    id: "x-cookie-risk-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#02050AF2",
  })

  const modal = new BoxRenderable(renderer, {
    id: "x-cookie-risk-modal",
    width: "88%",
    maxWidth: 76,
    height: "auto",
    padding: 2,
    flexDirection: "column",
    border: true,
    borderStyle: "double",
    borderColor: COLORS.error,
    backgroundColor: COLORS.panel,
    title: "ACCOUNT RISK",
    titleAlignment: "center",
  })
  modal.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.error)("Browser-cookie mode uses X's undocumented web GraphQL API."))}

${fg(COLORS.primary)("X's April 2026 automation rules warn that non-API website scripting may permanently suspend an account. Read-only access and browser-like headers do not remove that risk.")}

${fg(COLORS.secondary)("This client is deprecated and may send stale request shapes. Use the official API for an account you cannot afford to lose.")}`,
      width: "100%",
      wrapMode: "word",
    }),
  )
  authSelect = new SelectRenderable(renderer, {
    id: "x-cookie-risk-select",
    width: "100%",
    height: 4,
    marginTop: 1,
    options: [
      { name: "Go back", description: "Use the documented X API", value: "back" },
      {
        name: "I understand · continue",
        description: "Proceed with the undocumented cookie client",
        value: "continue",
      },
    ],
    selectedIndex: 1,
    backgroundColor: COLORS.card,
    focusedBackgroundColor: COLORS.card,
    textColor: COLORS.primary,
    focusedTextColor: COLORS.primary,
    selectedBackgroundColor: COLORS.selectedBackground,
    selectedTextColor: COLORS.selectedText,
    descriptionColor: COLORS.muted,
    selectedDescriptionColor: COLORS.selectedDescription,
    showDescription: true,
    wrapSelection: true,
    itemSpacing: 0,
  })
  enableSelectMouse(authSelect)
  authSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    queueMicrotask(() => {
      if (option.value === "continue") pushModalRoute("cookie-auth")
      else popModalRoute()
    })
  })
  modal.add(authSelect)
  addSelectHint(modal, renderer, "x-cookie-risk-hint", "confirm", popModalRoute)
  authOverlay.add(modal)
  renderer.root.add(authOverlay)
  authSelect.focus()
}

function showConnectionPicker(renderer: CliRenderer): void {
  destroyAuthOverlay()
  authOverlay = new BoxRenderable(renderer, {
    id: "x-connection-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#02050AE6",
  })

  const modal = new BoxRenderable(renderer, {
    id: "x-connection-modal",
    width: "86%",
    maxWidth: 68,
    height: "auto",
    padding: 2,
    flexDirection: "column",
    border: true,
    borderStyle: "double",
    borderColor: COLORS.accent,
    backgroundColor: COLORS.panel,
    title: "CONNECT X",
    titleAlignment: "center",
  })
  modal.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.primary)("Choose how this demo should access X."))}
${fg(COLORS.secondary)("The documented API is the default and recommended path.")}`,
      width: "100%",
      wrapMode: "word",
    }),
  )

  authSelect = new SelectRenderable(renderer, {
    id: "x-connection-select",
    width: "100%",
    height: 4,
    marginTop: 1,
    options: [
      { name: "Official X API", description: "OAuth 2.0 user token · documented · recommended", value: "official" },
      { name: "Browser session", description: "Undocumented GraphQL · permanent-suspension risk", value: "cookie" },
    ],
    selectedIndex: 0,
    backgroundColor: COLORS.card,
    focusedBackgroundColor: COLORS.card,
    textColor: COLORS.primary,
    focusedTextColor: COLORS.primary,
    selectedBackgroundColor: COLORS.selectedBackground,
    selectedTextColor: COLORS.selectedText,
    descriptionColor: COLORS.muted,
    selectedDescriptionColor: COLORS.selectedDescription,
    showDescription: true,
    wrapSelection: true,
    itemSpacing: 0,
  })
  enableSelectMouse(authSelect)
  authSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    if (option.value === "official") pushModalRoute("official-token")
    else pushModalRoute("cookie-risk")
  })
  modal.add(authSelect)
  addSelectHint(modal, renderer, "x-connection-hint", "continue", modalReturnsToFeed ? popModalRoute : undefined)
  authOverlay.add(modal)
  renderer.root.add(authOverlay)
  authSelect.focus()
}

function submitSession(value: string): void {
  const manualValue = value.trim()

  if (manualValue) {
    try {
      const cookies = parseManualSession(manualValue)
      client = twitterClientFactory({ cookies, timeoutMs: 20_000, quoteDepth: 1 })
      rememberBrowserSource(null)
      connectionMode = "cookie"
      selectedCookieSource = null
      officialToken = null
      officialUser = null
      sessionSource = "manual session"
      authMode = "manual"
      cookieSessionBlocked = false
      clearTimelineCaches()
      activateTimelineStream("home")
    } catch (error) {
      if (authHint) {
        authHint.content = t`${bold(fg(COLORS.error)("INVALID SESSION"))} ${fg(COLORS.secondary)(
          error instanceof Error ? error.message : String(error),
        )}`
      }
      return
    }
  } else {
    const sources = detectCookieSources()
    if (sources.length === 0) {
      if (authHint) {
        authHint.content = t`${bold(fg(COLORS.error)("NO COOKIE STORES FOUND"))} ${fg(COLORS.secondary)(
          "Sign in to x.com in a supported browser, or paste a session token above.",
        )}`
      }
      return
    }
    if (sources.length > 1) {
      browserRouteSources = sources
      pushModalRoute("browser")
      return
    }
    selectCookieSource(sources[0]!)
    return
  }

  closeModalFlow()
  void refreshTimeline(timelineState())
}

function showCookieAuthOverlay(renderer: CliRenderer): void {
  destroyAuthOverlay()
  authOverlay = new BoxRenderable(renderer, {
    id: "x-auth-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#02050AE6",
  })

  const modal = new BoxRenderable(renderer, {
    id: "x-auth-modal",
    width: "86%",
    maxWidth: 74,
    height: "auto",
    padding: 2,
    flexDirection: "column",
    border: true,
    borderStyle: "double",
    borderColor: COLORS.accent,
    backgroundColor: COLORS.panel,
    title: "CONNECT X",
    titleAlignment: "center",
  })
  modal.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.primary)("Use a session token or your browser login"))}
${fg(COLORS.secondary)("Paste the two-cookie session header below:")}
${fg(COLORS.accent)("auth_token=...; ct0=...")}

${fg(COLORS.secondary)("Leave it empty to detect browser cookie stores; you'll choose when multiple are found.")}
${fg(COLORS.muted)("The value is concealed, kept in memory only, and never logged.")}`,
      width: "100%",
      wrapMode: "word",
    }),
  )

  const inputBox = new BoxRenderable(renderer, {
    id: "x-auth-input-box",
    width: "100%",
    height: 3,
    marginTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.borderActive,
    backgroundColor: COLORS.card,
  })
  authInput = new InputRenderable(renderer, {
    id: "x-auth-input",
    width: "100%",
    maxLength: 2_048,
    textColor: COLORS.card,
    focusedTextColor: COLORS.card,
    backgroundColor: COLORS.card,
    focusedBackgroundColor: COLORS.card,
    cursorColor: COLORS.accent,
    attributes: TextAttributes.HIDDEN,
  })
  makeClickable(inputBox, () => authInput?.focus(), undefined, false)
  inputBox.add(authInput)
  modal.add(inputBox)

  authHint = addInputHint(modal, renderer, "x-auth-hint", t`${fg(COLORS.muted)("EMPTY")}`, "use browser cookies")

  authInput.on(InputRenderableEvents.INPUT, (inputValue: string) => {
    if (!authHint) return
    authHint.content = inputValue
      ? t`${fg(COLORS.green)(`SESSION · ${inputValue.length} CHARS`)}`
      : t`${fg(COLORS.muted)("EMPTY")}`
  })
  authInput.on(InputRenderableEvents.ENTER, submitSession)

  authOverlay.add(modal)
  renderer.root.add(authOverlay)
  authInput.focus()
}

function shouldStopCookieSession(message: string): boolean {
  return /HTTP\s+(?:401|403|429)\b|automated|suspend|locked|challenge|verification required/i.test(message)
}

function getRendererKeymap(renderer: CliRenderer): Keymap<Renderable, KeyEvent> {
  let keymap = rendererKeymaps.get(renderer)
  if (!keymap) {
    keymap = createDefaultOpenTuiKeymap(renderer)
    rendererKeymaps.set(renderer, keymap)
  }
  return keymap
}

function configuredBindings(commands: readonly XtuiCommandName[]): Record<string, string> {
  return Object.fromEntries(commands.map((command) => [command, activeConfig.keybindings[command]]))
}

function isUnmodifiedTextInput(event: KeyEvent): boolean {
  return (
    currentRenderer?.currentFocusedRenderable instanceof InputRenderable &&
    !event.ctrl &&
    !event.meta &&
    !event.super &&
    !event.hyper &&
    (event.name.length === 1 || event.name === "space")
  )
}

function registerXKeymap(renderer: CliRenderer): ConfigIssue[] {
  const keymap = getRendererKeymap(renderer)
  activeKeymap = keymap
  const configIssues: ConfigIssue[] = []
  for (const command of Object.keys(DEFAULT_KEYBINDINGS) as XtuiCommandName[]) {
    try {
      const sequence = keymap.parseKeySequence(activeConfig.keybindings[command])
      if (sequence.length !== 1) throw new Error("Expected one key stroke")
    } catch (error) {
      const fallback = DEFAULT_KEYBINDINGS[command]
      configIssues.push({
        path: `/keybindings/${command}`,
        message: `${error instanceof Error ? error.message : String(error)}; using default ${JSON.stringify(fallback)}`,
      })
      activeConfig.keybindings[command] = fallback
    }
  }
  const commandNames = Object.keys(DEFAULT_KEYBINDINGS) as XtuiCommandName[]
  const bindingMatch = (command: XtuiCommandName) =>
    keymap.parseKeySequence(activeConfig.keybindings[command])[0]!.match
  const helpDefault = DEFAULT_KEYBINDINGS["app.bindings"]
  const helpConflicts = commandNames.filter(
    (command) => command !== "app.bindings" && bindingMatch(command) === bindingMatch("app.bindings"),
  )
  const helpPart = keymap.parseKeySequence(activeConfig.keybindings["app.bindings"])[0]!
  const helpUsesEscape = helpPart.match === keymap.parseKeySequence("escape")[0]!.match
  const helpUsesCustomText =
    activeConfig.keybindings["app.bindings"] !== helpDefault &&
    !helpPart.stroke.ctrl &&
    !helpPart.stroke.meta &&
    !helpPart.stroke.super &&
    !helpPart.stroke.hyper &&
    (helpPart.stroke.name.length === 1 || helpPart.stroke.name === "space")
  if (
    helpUsesEscape ||
    helpUsesCustomText ||
    (activeConfig.keybindings["app.bindings"] !== helpDefault && helpConflicts.length > 0)
  ) {
    configIssues.push({
      path: "/keybindings/app.bindings",
      message: `${helpUsesEscape ? "Escape closes the bindings dialog" : helpUsesCustomText ? "Printable keys are reserved for text input" : `Conflicts with ${helpConflicts.join(", ")}`}; using default ${JSON.stringify(helpDefault)}`,
    })
    activeConfig.keybindings["app.bindings"] = helpDefault
  }
  const finalHelpMatch = bindingMatch("app.bindings")
  for (const command of commandNames) {
    if (command === "app.bindings" || bindingMatch(command) !== finalHelpMatch) continue
    const fallback = DEFAULT_KEYBINDINGS[command]
    configIssues.push({
      path: `/keybindings/${command}`,
      message: `Conflicts with global app.bindings; using default ${JSON.stringify(fallback)}`,
    })
    activeConfig.keybindings[command] = fallback
  }
  keymapDisposers.push(
    keymap.registerLayer({
      commands: [
        {
          name: "x.modal.back",
          run({ event }) {
            if (isUnmodifiedTextInput(event)) return false
            return popModalRoute()
          },
        },
        {
          name: "app.quit",
          run({ event }) {
            if (isUnmodifiedTextInput(event)) return false
            quitApplication()
          },
        },
        {
          name: "app.console",
          run({ event }) {
            if (isUnmodifiedTextInput(event)) return false
            toggleConsole()
          },
        },
        {
          name: "app.bindings",
          run() {
            return toggleBindingsOverlay()
          },
        },
        {
          name: "x.feed.next",
          run() {
            const state = timelineState()
            if (state) selectPost(state, state.selectedIndex + 1)
          },
        },
        {
          name: "x.feed.previous",
          run() {
            const state = timelineState()
            if (state) selectPost(state, state.selectedIndex - 1)
          },
        },
        {
          name: "x.feed.open",
          run() {
            return openTimelinePost()
          },
        },
        {
          name: "x.feed.image",
          run() {
            return openImageView()
          },
        },
        {
          name: "x.feed.comments",
          run() {
            return openCommentsView()
          },
        },
        {
          name: "x.feed.refresh",
          run() {
            void refreshTimeline()
          },
        },
        {
          name: "x.feed.toggle-expanded",
          run() {
            return toggleSelectedPostExpansion()
          },
        },
        {
          name: "x.feed.switch-stream",
          run() {
            return switchTimelineStream()
          },
        },
        {
          name: "x.comments.back",
          run() {
            return closeCommentsView()
          },
        },
        {
          name: "x.comments.next",
          run() {
            selectCommentsItem(selectedCommentsIndex + 1)
          },
        },
        {
          name: "x.comments.previous",
          run() {
            selectCommentsItem(selectedCommentsIndex - 1)
          },
        },
        {
          name: "x.comments.open",
          run() {
            return openSelectedCommentsTweet()
          },
        },
        {
          name: "x.comments.image",
          run() {
            return openImageView()
          },
        },
        {
          name: "x.image.next",
          run() {
            return navigateImageView(1)
          },
        },
        {
          name: "x.image.previous",
          run() {
            return navigateImageView(-1)
          },
        },
        {
          name: "x.image.zoom-in",
          run() {
            return zoomImageView(IMAGE_ZOOM_STEP)
          },
        },
        {
          name: "x.image.zoom-out",
          run() {
            return zoomImageView(-IMAGE_ZOOM_STEP)
          },
        },
        {
          name: "x.image.pan-left",
          run() {
            return panImageView(-IMAGE_PAN_COLUMNS, 0)
          },
        },
        {
          name: "x.image.pan-down",
          run() {
            return panImageView(0, IMAGE_PAN_ROWS)
          },
        },
        {
          name: "x.image.pan-up",
          run() {
            return panImageView(0, -IMAGE_PAN_ROWS)
          },
        },
        {
          name: "x.image.pan-right",
          run() {
            return panImageView(IMAGE_PAN_COLUMNS, 0)
          },
        },
        {
          name: "x.image.close",
          run() {
            return closeImageView()
          },
        },
        {
          name: "x.session.open",
          run() {
            return openSessionFlowFromFeed()
          },
        },
      ],
    }),
    keymap.registerLayer({
      priority: 10_000,
      enabled: canPopModalRoute,
      bindings: commandBindings(configuredBindings(["x.modal.back"])),
    }),
    keymap.registerLayer({
      bindings: commandBindings(configuredBindings(APP_COMMANDS)),
    }),
    keymap.registerLayer({
      priority: 15_000,
      bindings: commandBindings(configuredBindings(["app.bindings"])),
    }),
  )

  if (bindingsOverlay) {
    keymapDisposers.push(
      keymap.registerLayer({
        priority: 20_000,
        target: bindingsOverlay,
        targetMode: "focus-within",
        bindings: [{ key: "escape", cmd: closeBindingsOverlay }],
      }),
    )
  }

  for (const state of timelineStreams.values()) {
    keymapDisposers.push(
      keymap.registerLayer({
        target: state.feed,
        targetMode: "focus",
        bindings: commandBindings(configuredBindings(FEED_COMMANDS)),
      }),
    )
  }

  if (commentsFeed) {
    keymapDisposers.push(
      keymap.registerLayer({
        target: commentsFeed,
        targetMode: "focus",
        bindings: commandBindings(configuredBindings(COMMENTS_COMMANDS)),
      }),
    )
  }

  if (imageOverlay) {
    keymapDisposers.push(
      keymap.registerLayer({
        target: imageOverlay,
        targetMode: "focus",
        bindings: commandBindings(configuredBindings(IMAGE_COMMANDS)),
      }),
    )
  }

  return configIssues
}

async function refreshTimeline(
  state: TimelineStreamState | null = timelineState(),
  background: boolean = false,
): Promise<void> {
  if (!state || state.loading || state.loadingMore || !connectionMode) return
  if (connectionMode === "cookie" && cookieSessionBlocked) {
    setTimelineStatus(
      state,
      `Cookie session stopped after an account-control response · ${formatCommandKey("x.session.open")} reconnect`,
      COLORS.error,
    )
    return
  }

  const now = Date.now()
  if (now < state.nextRefreshAt) {
    if (!background) {
      const seconds = Math.ceil((state.nextRefreshAt - now) / 1_000)
      setTimelineStatus(state, `Refresh cooldown · ${seconds}s remaining`, COLORS.amber)
    }
    return
  }

  state.loading = true
  const requestEpoch = ++state.requestEpoch
  const currentGeneration = generation
  const currentSessionEpoch = sessionEpoch
  const cooldown = connectionMode === "official" ? OFFICIAL_REFRESH_COOLDOWN_MS : COOKIE_REFRESH_COOLDOWN_MS
  const streamLabel = state.stream === "following" ? "Following" : "Home"
  const activity = beginLoadingActivity(`${state.loaded ? "Refreshing" : "Loading"} ${streamLabel}`, 80)
  let succeeded = false

  if (!state.loaded && state.cards.length === 0) {
    showEmptyState(
      state,
      `LOADING ${streamLabel.toUpperCase()}`,
      connectionMode === "official"
        ? "Loading the documented reverse-chronological timeline."
        : `Loading ${streamLabel} with the active ${selectedCookieSource?.label ?? "browser"} session.`,
    )
  }
  setTimelineStatus(
    state,
    connectionMode === "official"
      ? "Calling the documented X API..."
      : client
        ? `${state.loaded ? "Refreshing" : "Loading"} the ${streamLabel} timeline...`
        : `Reading ${selectedCookieSource?.label ?? "browser"} session...`,
    COLORS.amber,
  )

  try {
    let tweets: TweetData[]
    let status: string

    if (connectionMode === "official") {
      const result = await fetchOfficialTimeline(undefined, currentGeneration, currentSessionEpoch)
      tweets = result.tweets
      state.officialNextToken = result.nextToken
      state.cookieRequestedCount = PAGE_SIZE
      state.hasMore = result.nextToken !== null
      const remaining = result.rateLimitRemaining ? ` · ${result.rateLimitRemaining} API requests remaining` : ""
      status = `${tweets.length} Following posts · X API v2 · read-only${remaining}`
    } else {
      let activeClient = client
      let source = sessionSource

      if (!activeClient) {
        if (!selectedCookieSource) throw new Error("No browser cookie source was selected.")
        const session = await findBrowserSession(selectedCookieSource)
        if (
          currentGeneration !== generation ||
          currentSessionEpoch !== sessionEpoch ||
          requestEpoch !== state.requestEpoch
        )
          return

        source = session.source
        activeClient = twitterClientFactory({ cookies: session.cookies, timeoutMs: REQUEST_TIMEOUT_MS, quoteDepth: 1 })
        client = activeClient
        sessionSource = source
        activity.update(`Loading ${streamLabel} via ${source}`)
        setTimelineStatus(state, `Connected via ${source}. Loading the ${streamLabel} timeline...`, COLORS.amber)
      }

      const result =
        state.stream === "following"
          ? await activeClient.getHomeLatestTimeline(PAGE_SIZE, { includeRaw: true })
          : await activeClient.getHomeTimeline(PAGE_SIZE, { includeRaw: true })
      if ("error" in result) throw new Error(result.error)
      tweets = normalizeCookieTweets(result.tweets)
      state.officialNextToken = null
      state.cookieRequestedCount = PAGE_SIZE
      state.hasMore = result.tweets.length >= PAGE_SIZE
      status = `${tweets.length} ${streamLabel} posts · ${source} · unofficial cookie mode`
    }

    if (currentGeneration !== generation || currentSessionEpoch !== sessionEpoch || requestEpoch !== state.requestEpoch)
      return
    const preserveViewport = state.loaded
    if (tweets.length === 0)
      showEmptyState(state, "YOUR HOME IS QUIET", `X returned no posts. ${formatCommandKey("x.feed.refresh")} refresh.`)
    else showTweets(state, tweets, preserveViewport)
    state.loaded = true
    setTimelineStatus(state, status, COLORS.green)
    succeeded = true
  } catch (error) {
    if (currentGeneration !== generation || currentSessionEpoch !== sessionEpoch || requestEpoch !== state.requestEpoch)
      return
    const message = error instanceof Error ? error.message : String(error)
    const cookieStop = connectionMode === "cookie" && shouldStopCookieSession(message)
    if (cookieStop) {
      cookieSessionBlocked = true
      client = null
    } else if (connectionMode === "cookie" && authMode !== "manual" && currentStream === state.stream) {
      client = null
    }

    if (state.cards.length === 0) {
      const retryHint =
        connectionMode === "official"
          ? `Verify this is a user-context OAuth token with tweet.read and users.read scopes, then ${formatCommandKey("x.session.open")} replace it.`
          : cookieStop
            ? "The cookie session has been stopped. Resolve any account prompt on x.com before reconnecting."
            : authMode === "manual"
              ? `Check the pasted auth_token and ct0 values, then ${formatCommandKey("x.session.open")} replace them.`
              : `Check the selected browser session, then ${formatCommandKey("x.session.open")} choose another source.`
      showEmptyState(state, "CAN'T LOAD X", `${message}\n\n${retryHint}`, "error")
    }
    setTimelineStatus(
      state,
      cookieStop
        ? `Cookie session stopped · ${formatCommandKey("x.session.open")} reconnect`
        : `Connection failed · ${formatCommandKey("x.session.open")} replace credentials`,
      COLORS.error,
    )
  } finally {
    activity.done()
    if (
      currentGeneration === generation &&
      currentSessionEpoch === sessionEpoch &&
      requestEpoch === state.requestEpoch
    ) {
      state.loading = false
      state.nextRefreshAt = Date.now() + cooldown
      if (succeeded) scheduleLoadMoreCheck(state)
    }
  }
}

async function loadMoreTimeline(state: TimelineStreamState | null = timelineState()): Promise<void> {
  if (
    !state ||
    currentView !== "timeline" ||
    currentStream !== state.stream ||
    !state.feed.visible ||
    state.loading ||
    state.loadingMore ||
    !state.hasMore ||
    !connectionMode ||
    currentRenderer?.isDestroyed
  )
    return
  state.loadingMore = true
  const requestEpoch = ++state.requestEpoch
  const currentGeneration = generation
  const currentSessionEpoch = sessionEpoch
  const streamLabel = state.stream === "following" ? "Following" : "Home"
  const activity = beginLoadingActivity(`Loading more ${streamLabel} posts`, 50)
  setTimelineStatus(state, `Loading more ${streamLabel} posts...`, COLORS.muted)
  let succeeded = false

  try {
    let added = 0
    if (connectionMode === "official") {
      const cursor = state.officialNextToken
      if (!cursor) {
        state.hasMore = false
        return
      }
      const result = await fetchOfficialTimeline(cursor, currentGeneration, currentSessionEpoch)
      if (
        currentGeneration !== generation ||
        currentSessionEpoch !== sessionEpoch ||
        requestEpoch !== state.requestEpoch
      )
        return
      added = appendTweets(state, result.tweets)
      state.officialNextToken = result.nextToken === cursor ? null : result.nextToken
      state.hasMore = state.officialNextToken !== null && added > 0
    } else {
      if (!client) {
        state.hasMore = false
        return
      }
      const requestedCount = state.cookieRequestedCount + PAGE_SIZE
      const result =
        state.stream === "following"
          ? await client.getHomeLatestTimeline(requestedCount, { includeRaw: true })
          : await client.getHomeTimeline(requestedCount, { includeRaw: true })
      if (
        currentGeneration !== generation ||
        currentSessionEpoch !== sessionEpoch ||
        requestEpoch !== state.requestEpoch
      )
        return
      if ("error" in result) throw new Error(result.error)
      added = appendTweets(state, normalizeCookieTweets(result.tweets))
      state.cookieRequestedCount = requestedCount
      state.hasMore = result.tweets.length >= requestedCount && added > 0
    }

    setTimelineStatus(
      state,
      added > 0
        ? `${state.tweets.length} posts · ${state.hasMore ? "scroll for more" : "end of timeline"}`
        : `${state.tweets.length} posts · end of timeline`,
      added > 0 ? COLORS.green : COLORS.secondary,
    )
    succeeded = true
  } catch (error) {
    if (currentGeneration !== generation || currentSessionEpoch !== sessionEpoch || requestEpoch !== state.requestEpoch)
      return
    state.hasMore = false
    setTimelineStatus(
      state,
      `Could not load more posts: ${error instanceof Error ? error.message : String(error)}`,
      COLORS.error,
    )
  } finally {
    activity.done()
    if (
      currentGeneration === generation &&
      currentSessionEpoch === sessionEpoch &&
      requestEpoch === state.requestEpoch
    ) {
      state.loadingMore = false
      if (succeeded) scheduleLoadMoreCheck(state)
    }
  }
}

function loadMoreNearBottom(state: TimelineStreamState): void {
  if (
    currentView !== "timeline" ||
    currentStream !== state.stream ||
    !state.feed.visible ||
    state.feed.isDestroyed ||
    !state.hasMore
  )
    return
  if (state.feed.viewport.height <= 0 || state.feed.scrollHeight <= 0) return
  const remaining = state.feed.scrollHeight - state.feed.scrollTop - state.feed.viewport.height
  if (remaining <= Math.max(3, state.feed.viewport.height * 2)) void loadMoreTimeline(state)
}

function scheduleLoadMoreCheck(state: TimelineStreamState): void {
  const currentGeneration = generation
  queueMicrotask(() => {
    if (currentGeneration === generation) loadMoreNearBottom(state)
  })
}

async function loadCommentsPage(): Promise<void> {
  if (
    currentView !== "comments" ||
    commentsLoading ||
    !commentsHasMore ||
    !commentsRootTweet ||
    !connectionMode ||
    currentRenderer?.isDestroyed
  )
    return
  commentsLoading = true
  const requestGeneration = commentsGeneration
  const cursor = commentsCursor ?? undefined
  const activity = beginLoadingActivity(cursor ? "Loading more comments" : "Loading comments", 70)

  try {
    const result = await fetchCommentsPage(commentsRootTweet.id, cursor)
    if (requestGeneration !== commentsGeneration || currentView !== "comments") return
    appendComments(result.tweets)
    commentsCursor = result.nextCursor === cursor ? null : result.nextCursor
    commentsHasMore = commentsCursor !== null
    const count = commentCount()
    if (count === 0) {
      setCommentsState(
        connectionMode === "official"
          ? "NO RECENT DIRECT REPLIES FOUND · X SEARCH COVERS THE LAST 7 DAYS"
          : "NO DIRECT REPLIES FOUND",
        COLORS.secondary,
      )
    } else {
      setCommentsState(commentsHasMore ? "SCROLL FOR MORE" : "END OF COMMENTS", COLORS.muted)
    }
    setStatus(
      `${count} comment${count === 1 ? "" : "s"} · ${commentsHasMore ? "scroll for more" : "end of comments"}`,
      COLORS.green,
    )
  } catch (error) {
    if (requestGeneration !== commentsGeneration || currentView !== "comments") return
    const message = error instanceof Error ? error.message : String(error)
    const cookieStop = connectionMode === "cookie" && shouldStopCookieSession(message)
    if (cookieStop) {
      cookieSessionBlocked = true
      client = null
    }
    commentsHasMore = false
    setCommentsState(
      commentCount() === 0 ? `COMMENTS UNAVAILABLE · ${message}` : `COULD NOT LOAD MORE · ${message}`,
      COLORS.error,
    )
    setStatus("Could not load comments", COLORS.error)
  } finally {
    activity.done()
    if (requestGeneration === commentsGeneration) {
      commentsLoading = false
      scheduleCommentsCheck()
    }
  }
}

function loadCommentsNearBottom(): void {
  if (currentView !== "comments" || !commentsFeed || commentsFeed.isDestroyed || !commentsHasMore) return
  if (commentsFeed.viewport.height <= 0 || commentsFeed.scrollHeight <= 0) return
  const remaining = commentsFeed.scrollHeight - commentsFeed.scrollTop - commentsFeed.viewport.height
  if (remaining <= Math.max(3, commentsFeed.viewport.height * 2)) void loadCommentsPage()
}

function scheduleCommentsCheck(): void {
  const requestGeneration = commentsGeneration
  queueMicrotask(() => {
    if (requestGeneration === commentsGeneration) loadCommentsNearBottom()
  })
}

function createMainScrollBox(renderer: CliRenderer, id: string, zIndex: number): ScrollBoxRenderable {
  const scrollBox = new ScrollBoxRenderable(renderer, {
    id,
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex,
    scrollX: false,
    scrollY: true,
    viewportCulling: true,
    rootOptions: { backgroundColor: COLORS.background },
    viewportOptions: { backgroundColor: COLORS.background },
    contentOptions: {
      flexDirection: "column",
      backgroundColor: COLORS.background,
    },
    verticalScrollbarOptions: {
      trackOptions: {
        foregroundColor: COLORS.accent,
        backgroundColor: COLORS.border,
      },
    },
  })
  scrollBox.verticalScrollBar.visible = activeConfig.scrollbar
  return scrollBox
}

function createTimelineStreamState(renderer: CliRenderer, stream: TimelineStream): TimelineStreamState {
  const streamFeed = createMainScrollBox(renderer, stream === "home" ? "x-feed" : "x-feed-following", 1)
  const state: TimelineStreamState = {
    stream,
    feed: streamFeed,
    cards: [],
    tweets: [],
    tweetIds: new Set(),
    postBodies: new Map(),
    postToggles: new Map(),
    expandedPostIds: new Set(),
    selectedIndex: -1,
    hasMore: false,
    officialNextToken: null,
    cookieRequestedCount: PAGE_SIZE,
    nextRefreshAt: 0,
    status: { message: "Waiting for a session...", color: COLORS.muted },
    loaded: false,
    loading: false,
    loadingMore: false,
    requestEpoch: 0,
    emptyState: null,
  }
  streamFeed.verticalScrollBar.on("change", () => loadMoreNearBottom(state))
  return state
}

function clearTimelineCaches(): void {
  sessionEpoch += 1
  loadingActivities.clear()
  updateActivityRow()
  for (const state of timelineStreams.values()) {
    state.requestEpoch += 1
    state.loading = false
    clearFeed(state)
    resetPaginationState(state)
    state.loaded = false
    state.nextRefreshAt = 0
    state.status = { message: "Waiting for a session...", color: COLORS.muted }
    state.feed.scrollTop = 0
  }
}

function activateTimelineStream(stream: TimelineStream, focus: boolean = true): TimelineStreamState | null {
  const state = timelineState(stream)
  if (!state) return null
  for (const candidate of timelineStreams.values()) {
    candidate.feed.visible = candidate === state
    candidate.feed.id = candidate === state ? "x-feed" : `x-feed-${candidate.stream}`
  }
  currentStream = stream
  feed = state.feed
  updateHeader()
  updateFooter()
  if (focus) state.feed.focus()
  return state
}

export function run(renderer: CliRenderer, options: XDemoRunOptions = {}): void {
  generation += 1
  currentRenderer = renderer
  activeConfig = {
    scrollbar: options.config?.scrollbar ?? DEFAULT_CONFIG.scrollbar,
    keybindings: { ...DEFAULT_KEYBINDINGS, ...options.config?.keybindings },
  }
  renderer.once(CliRenderEvents.DESTROY, () => {
    if (currentRenderer === renderer) destroy()
  })
  connectionMode = null
  officialToken = null
  officialUser = null
  currentStream = "home"
  authMode = null
  selectedCookieSource = null
  cookieSessionBlocked = false
  timelineStreams.clear()
  loadingActivities.clear()
  currentView = "timeline"
  timelineReturnState = null
  commentsRootTweet = null
  commentsItems = []
  commentTweetIds.clear()
  selectedCommentsIndex = -1
  commentsCursor = null
  commentsHasMore = false
  commentsLoading = false
  commentsPreparing = false
  commentsGeneration += 1
  imageTweet = null
  imageItems = []
  imageIndex = 0
  imageZoom = 1
  imagePanX = 0
  imagePanY = 0
  imageMessage = ""
  imageFallbackSource = null
  bindingsReturnFocus = null
  detectedBrowserOverride = options.detectedBrowsers ? [...options.detectedBrowsers] : null
  xApiBaseUrl = options.xApiBaseUrl?.replace(/\/+$/, "") || X_API_BASE_URL
  twitterClientFactory = options.twitterClientFactory ?? ((clientOptions) => new TwitterClient(clientOptions))
  openExternalUrl = options.openUrl ?? launchUrl
  renderer.setBackgroundColor(COLORS.background)
  renderer.setTerminalTitle("X · OpenTUI")

  root = new BoxRenderable(renderer, {
    id: "x-demo-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLORS.background,
  })

  const header = new BoxRenderable(renderer, {
    id: "x-header",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor: COLORS.panel,
  })
  headerText = new TextRenderable(renderer, {
    id: "x-header-text",
    content: "",
    height: 1,
    wrapMode: "none",
    selectable: false,
    flexShrink: 0,
  })
  headerHomeText = new TextRenderable(renderer, {
    id: "x-header-home",
    content: "",
    height: 1,
    wrapMode: "none",
    selectable: false,
    flexShrink: 0,
  })
  headerFollowingText = new TextRenderable(renderer, {
    id: "x-header-following",
    content: "",
    height: 1,
    wrapMode: "none",
    selectable: false,
    flexShrink: 0,
  })
  headerActionText = new TextRenderable(renderer, {
    id: "x-header-action",
    content: "",
    height: 1,
    wrapMode: "none",
    selectable: false,
    flexShrink: 0,
  })
  makeClickable(
    headerHomeText,
    () => setTimelineStream("home"),
    () => currentView === "timeline",
  )
  makeClickable(
    headerFollowingText,
    () => setTimelineStream("following"),
    () => currentView === "timeline",
  )
  makeClickable(headerActionText, closeCommentsView, () => currentView === "comments")
  header.add(headerText)
  header.add(headerHomeText)
  header.add(headerFollowingText)
  header.add(headerActionText)

  const statusBar = new BoxRenderable(renderer, {
    id: "x-status-bar",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: COLORS.background,
  })
  statusText = new TextRenderable(renderer, {
    id: "x-status",
    content: "",
    height: 1,
    wrapMode: "none",
  })
  statusBar.add(statusText)

  const viewStack = new BoxRenderable(renderer, {
    id: "x-view-stack",
    width: "100%",
    flexGrow: 1,
    position: "relative",
    backgroundColor: COLORS.background,
  })
  commentsFeed = createMainScrollBox(renderer, "x-comments-feed", 0)
  const homeState = createTimelineStreamState(renderer, "home")
  const followingState = createTimelineStreamState(renderer, "following")
  timelineStreams.set("home", homeState)
  timelineStreams.set("following", followingState)
  feed = homeState.feed
  followingState.feed.visible = false
  viewStack.add(commentsFeed)
  viewStack.add(homeState.feed)
  viewStack.add(followingState.feed)
  commentsScrollListener = loadCommentsNearBottom
  commentsFeed.verticalScrollBar.on("change", commentsScrollListener)
  const imageView = createImageView(renderer)
  const bindingsView = createBindingsOverlay(renderer)
  const keybindingIssues = registerXKeymap(renderer)
  updateHeader()

  footer = new BoxRenderable(renderer, {
    id: "x-footer",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor: COLORS.panel,
  })
  activityRow = new BoxRenderable(renderer, {
    id: "x-activity-row",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.panel,
  })
  activitySpinner = new SpinnerRenderable(renderer, {
    name: "dots",
    color: COLORS.amber,
    backgroundColor: "transparent",
    visible: false,
  })
  activitySpinner.id = "x-activity-spinner"
  activityLabel = new TextRenderable(renderer, {
    id: "x-activity-label",
    content: "",
    height: 1,
    marginLeft: 1,
    wrapMode: "none",
    selectable: false,
  })
  activityRow.add(activitySpinner)
  activityRow.add(activityLabel)
  updateActivityRow()
  updateFooter()
  resizeListener = () => {
    updateFooter()
    if (imageOverlay?.visible && currentRenderer)
      layoutImageView(currentRenderer.width, Math.max(1, currentRenderer.height - IMAGE_CHROME_ROWS))
  }
  renderer.on(CliRenderEvents.RESIZE, resizeListener)

  root.add(header)
  root.add(statusBar)
  root.add(viewStack)
  root.add(activityRow)
  root.add(footer)
  renderer.root.add(root)
  renderer.root.add(imageView)
  renderer.root.add(bindingsView)
  homeState.feed.focus()
  const rememberedSourceId = loadRememberedBrowserSource()
  const rememberedSource = rememberedSourceId
    ? detectCookieSources().find((source) => source.id === rememberedSourceId)
    : undefined
  if (rememberedSource) selectCookieSource(rememberedSource)
  else {
    setStatus("Waiting for a session...", COLORS.muted)
    openConnectionFlow(false)
  }
  if (keybindingIssues.length > 0) {
    for (const issue of keybindingIssues) console.error(formatConfigIssue(options.configPath ?? "configuration", issue))
    renderer.console.show()
  }
}

export function destroy(): void {
  generation += 1
  commentsGeneration += 1
  client = null
  connectionMode = null
  officialToken = null
  officialUser = null
  currentStream = "home"
  sessionSource = "browser"
  authMode = null
  selectedCookieSource = null
  detectedBrowserOverride = null
  activeKeymap = null
  cookieSessionBlocked = false
  currentView = "timeline"
  timelineReturnState = null
  commentsRootTweet = null
  commentsCursor = null
  commentsHasMore = false
  commentsLoading = false
  commentsPreparing = false
  imageTweet = null
  imageItems = []
  imageMessage = ""
  imageFallbackSource = null
  bindingsReturnFocus = null
  loadingActivities.clear()

  while (keymapDisposers.length > 0) keymapDisposers.pop()?.()
  modalRoutes = []
  browserRouteSources = []
  modalReturnsToFeed = false
  destroyAuthOverlay()
  if (commentsScrollListener && commentsFeed) commentsFeed.verticalScrollBar.off("change", commentsScrollListener)
  if (resizeListener && currentRenderer) currentRenderer.off(CliRenderEvents.RESIZE, resizeListener)
  commentsScrollListener = null
  resizeListener = null
  if (imageRenderable) imageRenderable.source = undefined
  bindingsOverlay?.destroyRecursively()
  imageOverlay?.destroyRecursively()
  for (const state of timelineStreams.values()) state.feed.destroyRecursively()
  commentsFeed?.destroyRecursively()
  root?.destroyRecursively()
  timelineStreams.clear()
  currentRenderer = null
  root = null
  feed = null
  commentsFeed = null
  activityRow = null
  activitySpinner = null
  activityLabel = null
  imageOverlay = null
  imageViewport = null
  imageRenderable = null
  imageHeaderText = null
  imageMetricsText = null
  bindingsOverlay = null
  bindingsList = null
  bindingsContextText = null
  bindingsCloseText = null
  statusText = null
  headerText = null
  headerHomeText = null
  headerFollowingText = null
  headerActionText = null
  footer = null
  commentsItems = []
  commentTweetIds.clear()
  selectedCommentsIndex = -1
  commentsStateText = null
}

if (import.meta.main) {
  const configResult = loadConfig()
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    consoleOptions: { position: ConsolePosition.TOP },
  })
  try {
    run(renderer, { config: configResult.config, configPath: configResult.path })
    if (configResult.issues.length > 0) {
      for (const issue of configResult.issues) console.error(formatConfigIssue(configResult.path, issue))
      renderer.console.show()
    }
  } catch (error) {
    renderer.destroy()
    throw error
  }
}
