#!/usr/bin/env bun

import { spawn } from "node:child_process"
import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  ImageError,
  ImageLoadError,
  ImageRenderable,
  InputRenderable,
  InputRenderableEvents,
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
  type Renderable,
  type SelectOption,
  type TextChunk,
} from "@opentui/core"
import type { Keymap } from "@opentui/keymap"
import { commandBindings, formatCommandBindings } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { TwitterClient, type TweetData, type TwitterCookies } from "@steipete/bird"
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
const POST_PREVIEW_GRAPHEMES = 280
const FEED_BINDINGS = {
  "x.feed.next": "j",
  "x.feed.previous": "k",
  "x.feed.open": "o",
  "x.feed.refresh": "r",
  "x.feed.toggle-expanded": "e",
  "x.feed.switch-stream": "tab",
  "x.session.open": "a",
} as const
const APP_BINDINGS = {
  "app.quit": "q",
  "app.console": "`",
} as const

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

const rendererKeymaps = new WeakMap<CliRenderer, Keymap<Renderable, KeyEvent>>()

let root: BoxRenderable | null = null
let currentRenderer: CliRenderer | null = null
let feed: ScrollBoxRenderable | null = null
let statusText: TextRenderable | null = null
let headerText: TextRenderable | null = null
let emptyState: BoxRenderable | null = null
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
let nextRefreshAt = 0
let cards: BoxRenderable[] = []
let timelineTweets: TweetData[] = []
let timelineTweetIds = new Set<string>()
let postBodies = new Map<string, TextRenderable>()
let expandedPostIds = new Set<string>()
let selectedIndex = -1
let loading = false
let loadingMore = false
let timelineHasMore = false
let officialNextToken: string | null = null
let cookieRequestedCount = PAGE_SIZE
let feedScrollListener: (() => void) | null = null
let loadingMoreIndicator: BoxRenderable | null = null
let generation = 0
let modalRoutes: ModalRoute[] = []
let modalReturnsToFeed = false
let browserRouteSources: CookieSource[] = []
let keymapDisposers: Array<() => void> = []
let activeKeymap: Keymap<Renderable, KeyEvent> | null = null

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
    const response = await fetch(`https://api.x.com${path}`, {
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

async function fetchOfficialTimeline(paginationToken?: string): Promise<{
  tweets: TweetData[]
  nextToken: string | null
  rateLimitRemaining: string | null
}> {
  if (!officialToken) throw new Error("An OAuth 2.0 user access token is required.")

  if (!officialUser) {
    const { data } = await fetchXApi<XApiUser>(
      "/2/users/me?user.fields=id,name,profile_image_url,username",
      officialToken,
    )
    officialUser = requireApiData(data, "the authenticated user")
  }

  const params = new URLSearchParams({
    max_results: String(PAGE_SIZE),
    "tweet.fields": "attachments,author_id,created_at,entities,public_metrics,referenced_tweets",
    expansions:
      "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id",
    "user.fields": "id,name,profile_image_url,username",
    "media.fields": "duration_ms,height,media_key,preview_image_url,type,url,width",
  })
  if (paginationToken) params.set("pagination_token", paginationToken)
  const { data, response } = await fetchXApi<XApiPost[]>(
    `/2/users/${encodeURIComponent(officialUser.id)}/timelines/reverse_chronological?${params.toString()}`,
    officialToken,
  )
  const posts = data.data ?? []
  const users = new Map((data.includes?.users ?? []).map((user) => [user.id, user]))
  const mediaByKey = new Map((data.includes?.media ?? []).map((media) => [media.media_key, media]))
  const includedTweets = new Map((data.includes?.tweets ?? []).map((tweet) => [tweet.id, tweet]))
  const mapPost = (post: XApiPost, fallbackAuthor: XApiUser, hydrateQuote: boolean): TweetData => {
    const author = (post.author_id ? users.get(post.author_id) : undefined) ?? fallbackAuthor
    const tweet: TweetData & { wrapperUrls?: string[] } = {
      id: post.id,
      text: post.text,
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
    if (hydrateQuote) {
      const reference = post.referenced_tweets?.find((item) => item.type === "quoted")
      const quotedPost = reference ? includedTweets.get(reference.id) : undefined
      const quotedAuthor = quotedPost?.author_id ? users.get(quotedPost.author_id) : undefined
      if (quotedPost && quotedAuthor) tweet.quotedTweet = mapPost(quotedPost, quotedAuthor, false)
    }
    return tweet
  }
  const tweets = posts.map((post) => mapPost(post, officialUser!, true))

  return {
    tweets,
    nextToken: data.meta?.next_token ?? null,
    rateLimitRemaining: response.headers.get("x-rate-limit-remaining"),
  }
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

function formatCommandKey(command: keyof typeof FEED_BINDINGS | keyof typeof APP_BINDINGS | "x.modal.back"): string {
  const bindings = activeKeymap?.getCommandBindings({ visibility: "registered", commands: [command] }).get(command)
  const fallback =
    command === "x.modal.back"
      ? "esc"
      : command in FEED_BINDINGS
        ? FEED_BINDINGS[command as keyof typeof FEED_BINDINGS]
        : APP_BINDINGS[command as keyof typeof APP_BINDINGS]
  return (
    formatCommandBindings(bindings, {
      keyNameAliases: { escape: "esc" },
      bindingSeparator: "/",
    }) ?? fallback
  ).toUpperCase()
}

function updateHeader(): void {
  if (!headerText) return
  const home =
    currentStream === "home" && connectionMode !== "official"
      ? underline(bold(fg(COLORS.primary)("HOME")))
      : fg(COLORS.muted)("HOME")
  const following =
    currentStream === "following" ? underline(bold(fg(COLORS.primary)("FOLLOWING"))) : fg(COLORS.muted)("FOLLOWING")
  headerText.content = t`${bold(fg(COLORS.primary)("X"))}  ${home}  ${following}  ${dim(fg(COLORS.secondary)(`${formatCommandKey("x.feed.switch-stream")} SWITCH · READ-ONLY`))}`
}

function resetPaginationState(): void {
  hideLoadingMoreIndicator()
  loadingMore = false
  timelineHasMore = false
  officialNextToken = null
  cookieRequestedCount = PAGE_SIZE
}

function switchTimelineStream(): boolean {
  if (!connectionMode || loading || loadingMore) return false
  if (connectionMode === "official") {
    currentStream = "following"
    updateHeader()
    setStatus("The documented X API exposes Following only; For You requires browser-session mode", COLORS.secondary)
    return true
  }

  currentStream = currentStream === "home" ? "following" : "home"
  updateHeader()
  resetPaginationState()
  nextRefreshAt = 0
  clearFeed()
  void refreshTimeline()
  return true
}

function postUrl(tweet: TweetData): string | null {
  if (!/^\d{1,19}$/.test(tweet.id) || !/^[A-Za-z0-9_]{1,15}$/.test(tweet.author.username)) return null
  return `https://x.com/${tweet.author.username}/status/${tweet.id}`
}

async function openPost(tweet: TweetData): Promise<void> {
  const url = postUrl(tweet)
  if (!url) throw new Error("The selected post has an invalid X URL.")

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

function postBodyContent(tweet: TweetData, expanded: boolean = false) {
  const article = tweet.article?.title ? `\nARTICLE · ${tweet.article.title}` : ""
  const preview = postPreview(displayPostText(tweet), expanded)
  const toggle = preview.isLong
    ? bold(
        fg(COLORS.amber)(`\n\n[${formatCommandKey("x.feed.toggle-expanded")}] ${expanded ? "Show Less" : "Show More"}`),
      )
    : null

  const chunks = [...styledMentions(preview.text).chunks]
  if (article) chunks.push(bold(fg(COLORS.amber)(article)))
  if (toggle) chunks.push(toggle)
  return new StyledText(chunks)
}

function addPostMetrics(card: BoxRenderable, tweet: TweetData, index: number): void {
  const row = new BoxRenderable(card.ctx, {
    id: `x-post-footer-${index}`,
    width: "100%",
    height: 1,
    marginTop: 1,
    flexDirection: "row",
    flexShrink: 0,
  })
  const metrics = [
    { id: "replies", content: `↩ ${compactCount(tweet.replyCount)}`, color: COLORS.secondary, align: "flex-start" },
    { id: "likes", content: `♥ ${compactCount(tweet.likeCount)}`, color: COLORS.pink, align: "center" },
    { id: "reposts", content: `↻ ${compactCount(tweet.retweetCount)}`, color: COLORS.green, align: "flex-end" },
  ] as const
  for (const metric of metrics) {
    const cell = new BoxRenderable(card.ctx, {
      id: `x-post-${metric.id}-${index}`,
      height: 1,
      flexDirection: "row",
      flexBasis: 0,
      flexGrow: 1,
      flexShrink: 1,
      alignItems: "center",
      justifyContent: metric.align,
    })
    cell.add(
      new TextRenderable(card.ctx, {
        content: metric.content,
        fg: metric.color,
        height: 1,
        wrapMode: "none",
      }),
    )
    row.add(cell)
  }
  card.add(row)
}

interface ImageFailureContext {
  kind: "avatar" | "media" | "quoted-avatar" | "quoted-media"
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
          kind: idPrefix === "x-post-quote" ? "quoted-avatar" : "avatar",
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
): void {
  const mediaItems = (tweet.media ?? []).filter((media) => Boolean(media.previewUrl || media.url))
  if (mediaItems.length === 0) return

  const mediaBox = new BoxRenderable(card.ctx, {
    id: `${idPrefix}-${postIndex}`,
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
  })

  for (const [mediaIndex, media] of mediaItems.entries()) {
    const source = media.previewUrl || media.url
    let sourceWidth = media.width ?? 0
    let sourceHeight = media.height ?? 0
    let heightUpdateQueued = false
    let image: ImageRenderable
    let failureReported = false

    const mediaStatus = new TextRenderable(card.ctx, {
      id: `${idPrefix}-status-${postIndex}-${mediaIndex}`,
      content: `LOADING ${media.type === "photo" ? "IMAGE" : "VIDEO PREVIEW"}`,
      fg: COLORS.muted,
      wrapMode: "word",
    })

    const updateHeight = () => {
      heightUpdateQueued = false
      if (image.isDestroyed || image.width <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return
      const naturalRows = Math.round((image.width * sourceHeight) / (sourceWidth * image.cellAspectRatio))
      const nextHeight = Math.max(MEDIA_MIN_ROWS, Math.min(MEDIA_MAX_ROWS, naturalRows))
      if (image.height !== nextHeight) image.height = nextHeight
    }
    const scheduleHeightUpdate = () => {
      if (heightUpdateQueued) return
      heightUpdateQueued = true
      queueMicrotask(updateHeight)
    }
    const handleMediaFailure = (error: unknown) => {
      if (failureReported) return
      failureReported = true
      const reason = reportImageFailure(
        {
          kind: idPrefix === "x-post-quote-media" ? "quoted-media" : "media",
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
      width: "100%",
      height: MEDIA_MIN_ROWS,
      flexShrink: 0,
      fit: "fit",
      protocol: "auto",
      onSizeChange: scheduleHeightUpdate,
      onLoad: (loaded) => {
        sourceWidth = loaded.width
        sourceHeight = loaded.height
        mediaStatus.content = media.type === "photo" ? "" : "VIDEO PREVIEW"
        mediaStatus.fg = COLORS.muted
        mediaStatus.visible = media.type !== "photo"
        scheduleHeightUpdate()
      },
      onError: handleMediaFailure,
    })
    void image.loadPromise?.catch(handleMediaFailure)
    mediaBox.add(image)
    mediaBox.add(mediaStatus)
  }

  card.add(mediaBox)
}

function addQuotedPost(card: BoxRenderable, tweet: TweetData, postIndex: number): void {
  const quoted = tweet.quotedTweet
  if (!quoted) return

  const quoteCard = new BoxRenderable(card.ctx, {
    id: `x-post-quote-${postIndex}`,
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  })
  addPostAuthor(quoteCard, quoted, postIndex, "x-post-quote")
  quoteCard.add(
    new TextRenderable(card.ctx, {
      id: `x-post-quote-content-${postIndex}`,
      content: styledMentions(cleanPostText(displayPostText(quoted)), COLORS.secondary),
      width: "100%",
      wrapMode: "word",
      selectable: true,
    }),
  )
  addPostMedia(quoteCard, quoted, postIndex, "x-post-quote-media")
  card.add(quoteCard)
}

function clearFeed(): void {
  for (const card of cards) card.destroyRecursively()
  cards = []
  timelineTweets = []
  timelineTweetIds.clear()
  postBodies.clear()
  expandedPostIds.clear()
  selectedIndex = -1

  if (emptyState) {
    emptyState.destroyRecursively()
    emptyState = null
  }
}

function showEmptyState(title: string, message: string, tone: "loading" | "error" = "loading"): void {
  if (!feed) return
  clearFeed()

  emptyState = new BoxRenderable(feed.ctx, {
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
  emptyState.add(
    new TextRenderable(feed.ctx, {
      content: t`${bold(fg(tone === "error" ? COLORS.error : COLORS.accent)(title))}

${fg(COLORS.secondary)(message)}`,
      wrapMode: "word",
    }),
  )
  feed.add(emptyState)
}

function selectPost(nextIndex: number, loadMore: boolean = true): void {
  if (!feed || cards.length === 0) return
  selectedIndex = Math.max(0, Math.min(nextIndex, cards.length - 1))

  for (const [index, card] of cards.entries()) {
    const selected = index === selectedIndex
    card.backgroundColor = selected ? COLORS.cardActive : COLORS.card
    card.borderColor = selected ? COLORS.borderActive : COLORS.border
  }

  const selectedCard = cards[selectedIndex]
  if (selectedCard) feed.scrollChildIntoView(selectedCard.id)
  if (loadMore && selectedIndex >= timelineTweets.length - 5) void loadMoreTimeline()
}

function createLoadingMoreIndicator(): BoxRenderable | null {
  if (!feed) return null
  const indicator = new BoxRenderable(feed.ctx, {
    id: "x-loading-more",
    position: "absolute",
    left: 0,
    bottom: 0,
    width: "100%",
    height: 1,
    flexShrink: 0,
    zIndex: 50,
    backgroundColor: COLORS.panel,
    visible: false,
  })
  indicator.add(
    new TextRenderable(feed.ctx, {
      id: "x-loading-more-text",
      content: t`${fg(COLORS.secondary)("···")} ${bold(fg(COLORS.primary)("LOADING MORE POSTS"))}`,
      height: 1,
      wrapMode: "none",
    }),
  )
  return indicator
}

function showLoadingMoreIndicator(): void {
  if (loadingMoreIndicator && !loadingMoreIndicator.isDestroyed) loadingMoreIndicator.visible = true
}

function hideLoadingMoreIndicator(): void {
  if (loadingMoreIndicator && !loadingMoreIndicator.isDestroyed) loadingMoreIndicator.visible = false
}

function toggleSelectedPostExpansion(): boolean {
  const tweet = timelineTweets[selectedIndex]
  if (!tweet || !postPreview(displayPostText(tweet), false).isLong) return false
  const body = postBodies.get(tweet.id)
  if (!body) return false

  const expanded = !expandedPostIds.has(tweet.id)
  if (expanded) expandedPostIds.add(tweet.id)
  else expandedPostIds.delete(tweet.id)
  body.content = postBodyContent(tweet, expanded)
  queueMicrotask(() => feed?.scrollChildIntoView(`x-post-${tweet.id}`))
  return true
}

function createPostCard(tweet: TweetData, index: number): BoxRenderable | null {
  if (!feed) return null
  const card = new BoxRenderable(feed.ctx, {
    id: `x-post-${tweet.id}`,
    width: "100%",
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.card,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    flexShrink: 0,
  })
  addPostAuthor(card, tweet, index)
  const body = new TextRenderable(feed.ctx, {
    id: `x-post-content-${index}`,
    content: postBodyContent(tweet, expandedPostIds.has(tweet.id)),
    width: "100%",
    wrapMode: "word",
    selectable: true,
  })
  postBodies.set(tweet.id, body)
  card.add(body)
  addPostMedia(card, tweet, index)
  addQuotedPost(card, tweet, index)
  addPostMetrics(card, tweet, index)
  return card
}

function appendTweets(tweets: readonly TweetData[]): number {
  if (!feed) return 0
  let added = 0
  for (const tweet of tweets) {
    if (timelineTweetIds.has(tweet.id)) continue
    const index = timelineTweets.length
    const card = createPostCard(tweet, index)
    if (!card) continue
    timelineTweetIds.add(tweet.id)
    timelineTweets.push(tweet)
    cards.push(card)
    feed.add(card)
    added += 1
  }
  return added
}

function showTweets(tweets: readonly TweetData[]): void {
  if (!feed) return
  clearFeed()
  appendTweets(tweets)

  if (cards.length > 0) selectPost(0, false)
}

function setStatus(message: string, color: string): void {
  if (!statusText) return
  statusText.content = t`${bold(fg(color)("●"))} ${fg(COLORS.secondary)(message)}`
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

function selectCookieSource(source: CookieSource): void {
  rememberBrowserSource(source.id)
  connectionMode = "cookie"
  currentStream = "home"
  selectedCookieSource = source
  client = null
  officialToken = null
  officialUser = null
  sessionSource = source.label
  authMode = "browser"
  cookieSessionBlocked = false
  updateHeader()
  closeModalFlow()
  void refreshTimeline()
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
  })
  authSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    selectCookieSource(option.value as CookieSource)
  })
  selectBox.add(authSelect)
  modal.add(selectBox)
  modal.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.accent)(`${formatKeyLabel("up")}/${formatKeyLabel("down")} or ${formatKeyLabel("j")}/${formatKeyLabel("k")}`))} ${fg(COLORS.secondary)("choose")}   ${bold(fg(COLORS.green)(formatKeyLabel("return")))} ${fg(COLORS.secondary)("continue")}   ${bold(fg(COLORS.secondary)(formatCommandKey("x.modal.back")))} ${fg(COLORS.secondary)("back")}`,
      marginTop: 1,
      wrapMode: "word",
    }),
  )

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
  currentStream = "following"
  client = null
  selectedCookieSource = null
  sessionSource = "X API v2"
  cookieSessionBlocked = false
  updateHeader()
  closeModalFlow()
  void refreshTimeline()
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
  inputBox.add(authInput)
  modal.add(inputBox)

  authHint = new TextRenderable(renderer, {
    id: "x-official-token-hint",
    content: t`${fg(COLORS.muted)(`Paste token · ${formatKeyLabel("return")} continue · ${formatCommandKey("x.modal.back")} back`)}`,
    marginTop: 1,
    wrapMode: "word",
  })
  modal.add(authHint)
  authInput.on(InputRenderableEvents.INPUT, (inputValue: string) => {
    if (!authHint) return
    authHint.content = inputValue
      ? t`${fg(COLORS.green)(`TOKEN ENTERED · ${inputValue.length} characters · ${formatKeyLabel("return")} continue`)}`
      : t`${fg(COLORS.muted)(`Paste token · ${formatKeyLabel("return")} continue · ${formatCommandKey("x.modal.back")} back`)}`
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
  })
  authSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    queueMicrotask(() => {
      if (option.value === "continue") pushModalRoute("cookie-auth")
      else popModalRoute()
    })
  })
  modal.add(authSelect)
  modal.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.accent)(`${formatKeyLabel("up")}/${formatKeyLabel("down")} or ${formatKeyLabel("j")}/${formatKeyLabel("k")}`))} ${fg(COLORS.secondary)("choose")}   ${bold(fg(COLORS.error)(formatKeyLabel("return")))} ${fg(COLORS.secondary)("confirm")}   ${bold(fg(COLORS.secondary)(formatCommandKey("x.modal.back")))} ${fg(COLORS.secondary)("back")}`,
      marginTop: 1,
      wrapMode: "word",
    }),
  )
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
  })
  authSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    if (option.value === "official") pushModalRoute("official-token")
    else pushModalRoute("cookie-risk")
  })
  modal.add(authSelect)
  modal.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.accent)(`${formatKeyLabel("up")}/${formatKeyLabel("down")} or ${formatKeyLabel("j")}/${formatKeyLabel("k")}`))} ${fg(COLORS.secondary)("choose")}   ${bold(fg(COLORS.green)(formatKeyLabel("return")))} ${fg(COLORS.secondary)("continue")}   ${bold(fg(COLORS.secondary)(formatCommandKey("x.modal.back")))} ${fg(COLORS.secondary)("back")}`,
      marginTop: 1,
      wrapMode: "word",
    }),
  )
  authOverlay.add(modal)
  renderer.root.add(authOverlay)
  authSelect.focus()
}

function submitSession(value: string): void {
  const manualValue = value.trim()

  if (manualValue) {
    try {
      const cookies = parseManualSession(manualValue)
      client = new TwitterClient({ cookies, timeoutMs: 20_000, quoteDepth: 1 })
      rememberBrowserSource(null)
      connectionMode = "cookie"
      currentStream = "home"
      selectedCookieSource = null
      officialToken = null
      officialUser = null
      sessionSource = "manual session"
      authMode = "manual"
      cookieSessionBlocked = false
      updateHeader()
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
  void refreshTimeline()
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
  inputBox.add(authInput)
  modal.add(inputBox)

  authHint = new TextRenderable(renderer, {
    id: "x-auth-hint",
    content: t`${fg(COLORS.muted)(`EMPTY · ${formatKeyLabel("return")} use browser cookies · ${formatCommandKey("x.modal.back")} back`)}`,
    marginTop: 1,
    wrapMode: "word",
  })
  modal.add(authHint)

  authInput.on(InputRenderableEvents.INPUT, (inputValue: string) => {
    if (!authHint) return
    authHint.content = inputValue
      ? t`${fg(COLORS.green)(`SESSION ENTERED · ${inputValue.length} characters · ${formatKeyLabel("return")} continue`)}`
      : t`${fg(COLORS.muted)(`EMPTY · ${formatKeyLabel("return")} use browser cookies · ${formatCommandKey("x.modal.back")} back`)}`
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

function registerXKeymap(renderer: CliRenderer): Keymap<Renderable, KeyEvent> {
  const keymap = getRendererKeymap(renderer)
  activeKeymap = keymap
  keymapDisposers.push(
    keymap.registerLayer({
      commands: [
        {
          name: "x.modal.back",
          run() {
            return popModalRoute()
          },
        },
        {
          name: "app.quit",
          run() {
            renderer.destroy()
          },
        },
        {
          name: "app.console",
          run() {
            renderer.console.toggle()
          },
        },
        {
          name: "x.feed.next",
          run() {
            selectPost(selectedIndex + 1)
          },
        },
        {
          name: "x.feed.previous",
          run() {
            selectPost(selectedIndex - 1)
          },
        },
        {
          name: "x.feed.open",
          async run() {
            const tweet = timelineTweets[selectedIndex]
            if (!tweet) return false
            try {
              await openPost(tweet)
              setStatus("Opened the selected post on X", COLORS.green)
            } catch (error) {
              setStatus(`Could not open X: ${error instanceof Error ? error.message : String(error)}`, COLORS.error)
            }
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
          name: "x.session.open",
          run() {
            if (loading) return false
            client = null
            connectionMode = null
            officialToken = null
            officialUser = null
            selectedCookieSource = null
            authMode = null
            cookieSessionBlocked = false
            nextRefreshAt = 0
            setStatus("Waiting for a session...", COLORS.muted)
            openConnectionFlow(true)
          },
        },
      ],
    }),
    keymap.registerLayer({
      priority: 10_000,
      enabled: canPopModalRoute,
      bindings: commandBindings({ "x.modal.back": "escape" }),
    }),
    keymap.registerLayer({
      priority: -10_000,
      bindings: [{ key: "escape", cmd: "app.quit" }],
    }),
  )

  if (feed) {
    keymapDisposers.push(
      keymap.registerLayer({
        target: feed,
        targetMode: "focus",
        bindings: commandBindings({ ...FEED_BINDINGS, ...APP_BINDINGS }),
      }),
    )
  }

  return keymap
}

async function refreshTimeline(): Promise<void> {
  if (loading || loadingMore || !connectionMode) return
  if (connectionMode === "cookie" && cookieSessionBlocked) {
    setStatus(
      `Cookie session stopped after an account-control response · ${formatCommandKey("x.session.open")} reconnect`,
      COLORS.error,
    )
    return
  }

  const now = Date.now()
  if (now < nextRefreshAt) {
    const seconds = Math.ceil((nextRefreshAt - now) / 1_000)
    setStatus(`Refresh cooldown · ${seconds}s remaining`, COLORS.amber)
    return
  }

  loading = true
  const currentGeneration = generation
  const cooldown = connectionMode === "official" ? OFFICIAL_REFRESH_COOLDOWN_MS : COOKIE_REFRESH_COOLDOWN_MS

  if (cards.length === 0) {
    const sourceName =
      connectionMode === "official" ? "the documented X API" : (selectedCookieSource?.label ?? "browser")
    showEmptyState(
      "CONNECTING TO X",
      connectionMode === "official"
        ? `Loading the reverse-chronological home timeline from ${sourceName}.`
        : `Looking for a signed-in x.com session in ${sourceName}. Cookie values stay in memory and are never displayed.`,
    )
  }
  setStatus(
    connectionMode === "official"
      ? "Calling the documented X API..."
      : client
        ? "Refreshing the browser-session timeline..."
        : `Reading ${selectedCookieSource?.label ?? "browser"} session...`,
    COLORS.amber,
  )

  try {
    let tweets: TweetData[]
    let status: string

    if (connectionMode === "official") {
      currentStream = "following"
      updateHeader()
      const result = await fetchOfficialTimeline()
      tweets = result.tweets
      officialNextToken = result.nextToken
      cookieRequestedCount = PAGE_SIZE
      timelineHasMore = result.nextToken !== null
      const remaining = result.rateLimitRemaining ? ` · ${result.rateLimitRemaining} API requests remaining` : ""
      status = `${tweets.length} Following posts · X API v2 · read-only${remaining}`
    } else {
      let activeClient = client
      let source = sessionSource

      if (!activeClient) {
        if (!selectedCookieSource) throw new Error("No browser cookie source was selected.")
        const session = await findBrowserSession(selectedCookieSource)
        if (currentGeneration !== generation) return

        source = session.source
        activeClient = new TwitterClient({ cookies: session.cookies, timeoutMs: REQUEST_TIMEOUT_MS, quoteDepth: 1 })
        client = activeClient
        sessionSource = source
        setStatus(`Connected via ${source}. Loading the timeline...`, COLORS.amber)
      }

      const result =
        currentStream === "following"
          ? await activeClient.getHomeLatestTimeline(PAGE_SIZE, { includeRaw: true })
          : await activeClient.getHomeTimeline(PAGE_SIZE, { includeRaw: true })
      if ("error" in result) throw new Error(result.error)
      tweets = result.tweets
      officialNextToken = null
      cookieRequestedCount = PAGE_SIZE
      timelineHasMore = result.tweets.length >= PAGE_SIZE
      status = `${tweets.length} ${currentStream === "following" ? "Following" : "Home"} posts · ${source} · unofficial cookie mode`
    }

    if (currentGeneration !== generation) return
    if (tweets.length === 0)
      showEmptyState("YOUR HOME IS QUIET", `X returned no posts. ${formatCommandKey("x.feed.refresh")} refresh.`)
    else showTweets(tweets)
    setStatus(status, COLORS.green)
  } catch (error) {
    if (currentGeneration !== generation) return
    const message = error instanceof Error ? error.message : String(error)
    const cookieStop = connectionMode === "cookie" && shouldStopCookieSession(message)
    if (cookieStop) {
      cookieSessionBlocked = true
      client = null
    } else if (connectionMode === "cookie" && authMode !== "manual") {
      client = null
    }

    if (cards.length === 0) {
      const retryHint =
        connectionMode === "official"
          ? `Verify this is a user-context OAuth token with tweet.read and users.read scopes, then ${formatCommandKey("x.session.open")} replace it.`
          : cookieStop
            ? "The cookie session has been stopped. Resolve any account prompt on x.com before reconnecting."
            : authMode === "manual"
              ? `Check the pasted auth_token and ct0 values, then ${formatCommandKey("x.session.open")} replace them.`
              : `Check the selected browser session, then ${formatCommandKey("x.session.open")} choose another source.`
      showEmptyState("CAN'T LOAD X", `${message}\n\n${retryHint}`, "error")
    }
    setStatus(
      cookieStop
        ? `Cookie session stopped · ${formatCommandKey("x.session.open")} reconnect`
        : `Connection failed · ${formatCommandKey("x.session.open")} replace credentials`,
      COLORS.error,
    )
  } finally {
    if (currentGeneration === generation) {
      loading = false
      nextRefreshAt = Date.now() + cooldown
      scheduleLoadMoreCheck()
    }
  }
}

async function loadMoreTimeline(): Promise<void> {
  if (loading || loadingMore || !timelineHasMore || !connectionMode || currentRenderer?.isDestroyed) return
  loadingMore = true
  showLoadingMoreIndicator()
  const currentGeneration = generation
  setStatus("Loading more posts...", COLORS.muted)

  try {
    let added = 0
    if (connectionMode === "official") {
      const cursor = officialNextToken
      if (!cursor) {
        timelineHasMore = false
        return
      }
      const result = await fetchOfficialTimeline(cursor)
      if (currentGeneration !== generation) return
      hideLoadingMoreIndicator()
      added = appendTweets(result.tweets)
      officialNextToken = result.nextToken === cursor ? null : result.nextToken
      timelineHasMore = officialNextToken !== null && added > 0
    } else {
      if (!client) {
        timelineHasMore = false
        return
      }
      const requestedCount = cookieRequestedCount + PAGE_SIZE
      const result =
        currentStream === "following"
          ? await client.getHomeLatestTimeline(requestedCount, { includeRaw: true })
          : await client.getHomeTimeline(requestedCount, { includeRaw: true })
      if (currentGeneration !== generation) return
      if ("error" in result) throw new Error(result.error)
      hideLoadingMoreIndicator()
      added = appendTweets(result.tweets)
      cookieRequestedCount = requestedCount
      timelineHasMore = result.tweets.length >= requestedCount && added > 0
    }

    setStatus(
      added > 0
        ? `${timelineTweets.length} posts · ${timelineHasMore ? "scroll for more" : "end of timeline"}`
        : `${timelineTweets.length} posts · end of timeline`,
      added > 0 ? COLORS.green : COLORS.secondary,
    )
  } catch (error) {
    if (currentGeneration !== generation) return
    setStatus(`Could not load more posts: ${error instanceof Error ? error.message : String(error)}`, COLORS.error)
  } finally {
    if (currentGeneration === generation) {
      hideLoadingMoreIndicator()
      loadingMore = false
      scheduleLoadMoreCheck()
    }
  }
}

function loadMoreNearBottom(): void {
  if (!feed || feed.isDestroyed || !timelineHasMore) return
  if (feed.viewport.height <= 0 || feed.scrollHeight <= 0) return
  const remaining = feed.scrollHeight - feed.scrollTop - feed.viewport.height
  if (remaining <= Math.max(3, feed.viewport.height * 2)) void loadMoreTimeline()
}

function scheduleLoadMoreCheck(): void {
  const currentGeneration = generation
  queueMicrotask(() => {
    if (currentGeneration === generation) loadMoreNearBottom()
  })
}

export function run(renderer: CliRenderer, options: XDemoRunOptions = {}): void {
  generation += 1
  currentRenderer = renderer
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
  nextRefreshAt = 0
  loadingMore = false
  timelineHasMore = false
  officialNextToken = null
  cookieRequestedCount = PAGE_SIZE
  detectedBrowserOverride = options.detectedBrowsers ? [...options.detectedBrowsers] : null
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
    backgroundColor: COLORS.panel,
  })
  headerText = new TextRenderable(renderer, {
    id: "x-header-text",
    content: "",
    height: 1,
    wrapMode: "none",
  })
  header.add(headerText)

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

  feed = new ScrollBoxRenderable(renderer, {
    id: "x-feed",
    width: "100%",
    flexGrow: 1,
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
  loadingMoreIndicator = createLoadingMoreIndicator()
  if (loadingMoreIndicator) feed.viewport.add(loadingMoreIndicator)
  feedScrollListener = loadMoreNearBottom
  feed.verticalScrollBar.on("change", feedScrollListener)
  registerXKeymap(renderer)
  updateHeader()
  const selectionKeys = `${formatCommandKey("x.feed.next")}/${formatCommandKey("x.feed.previous")}`
  const openKey = formatCommandKey("x.feed.open")
  const refreshKey = formatCommandKey("x.feed.refresh")
  const sessionKey = formatCommandKey("x.session.open")
  const quitKey = formatCommandKey("app.quit")
  const consoleKey = formatCommandKey("app.console")

  const footer = new BoxRenderable(renderer, {
    id: "x-footer",
    width: "100%",
    height: 1,
    flexShrink: 0,
    backgroundColor: COLORS.panel,
  })
  footer.add(
    new TextRenderable(renderer, {
      content: t`${bold(fg(COLORS.accent)(selectionKeys))} ${fg(COLORS.secondary)("select")}   ${bold(fg(COLORS.accent)(`${formatKeyLabel("up")}/${formatKeyLabel("down")}`))} ${fg(COLORS.secondary)("scroll")}   ${bold(fg(COLORS.accent)(openKey))} ${fg(COLORS.secondary)("open")}   ${bold(fg(COLORS.green)(refreshKey))} ${fg(COLORS.secondary)("refresh")}   ${bold(fg(COLORS.amber)(sessionKey))} ${fg(COLORS.secondary)("session")}   ${bold(fg(COLORS.secondary)(consoleKey))} ${fg(COLORS.secondary)("logs")}   ${bold(fg(COLORS.error)(quitKey))} ${fg(COLORS.secondary)("quit")}`,
      height: 1,
      wrapMode: "none",
    }),
  )

  root.add(header)
  root.add(statusBar)
  root.add(feed)
  root.add(footer)
  renderer.root.add(root)
  feed.focus()
  const rememberedSourceId = loadRememberedBrowserSource()
  const rememberedSource = rememberedSourceId
    ? detectCookieSources().find((source) => source.id === rememberedSourceId)
    : undefined
  if (rememberedSource) selectCookieSource(rememberedSource)
  else {
    setStatus("Waiting for a session...", COLORS.muted)
    openConnectionFlow(false)
  }
}

export function destroy(): void {
  generation += 1
  loading = false
  loadingMore = false
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
  nextRefreshAt = 0
  timelineHasMore = false
  officialNextToken = null
  cookieRequestedCount = PAGE_SIZE

  while (keymapDisposers.length > 0) keymapDisposers.pop()?.()
  modalRoutes = []
  browserRouteSources = []
  modalReturnsToFeed = false
  destroyAuthOverlay()
  hideLoadingMoreIndicator()
  if (feedScrollListener && feed) feed.verticalScrollBar.off("change", feedScrollListener)
  feedScrollListener = null
  root?.destroyRecursively()
  loadingMoreIndicator = null
  currentRenderer = null
  root = null
  feed = null
  statusText = null
  headerText = null
  emptyState = null
  cards = []
  timelineTweets = []
  timelineTweetIds.clear()
  postBodies.clear()
  expandedPostIds.clear()
  selectedIndex = -1
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })
  try {
    run(renderer)
  } catch (error) {
    renderer.destroy()
    throw error
  }
}
