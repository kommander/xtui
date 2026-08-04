import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import * as z from "zod"

export const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/kommander/xtui/main/xtui.schema.json"

export const DEFAULT_KEYBINDINGS = {
  "x.feed.next": "j",
  "x.feed.previous": "k",
  "x.feed.open": "o",
  "x.feed.image": "i",
  "x.feed.comments": "c",
  "x.feed.refresh": "r",
  "x.feed.toggle-expanded": "e",
  "x.feed.switch-stream": "tab",
  "x.session.open": "a",
  "x.comments.next": "j",
  "x.comments.previous": "k",
  "x.comments.open": "o",
  "x.comments.image": "i",
  "x.comments.back": "escape",
  "x.image.next": "right",
  "x.image.previous": "left",
  "x.image.zoom-in": "+",
  "x.image.zoom-out": "-",
  "x.image.pan-left": "h",
  "x.image.pan-down": "j",
  "x.image.pan-up": "k",
  "x.image.pan-right": "l",
  "x.image.close": "escape",
  "x.modal.back": "escape",
  "app.console": "`",
  "app.quit": "ctrl+c",
} as const

export type XtuiCommandName = keyof typeof DEFAULT_KEYBINDINGS
export type XtuiKeybindings = Record<XtuiCommandName, string>

export interface XtuiConfig {
  scrollbar: boolean
  keybindings: XtuiKeybindings
}

export interface ConfigIssue {
  message: string
  path?: string
  line?: number
  column?: number
}

export interface ConfigLoadResult {
  config: XtuiConfig
  issues: ConfigIssue[]
  path: string
}

const keybindingSchema = z
  .string()
  .min(1, "Expected a non-empty key binding")
  .describe("A single OpenTUI key stroke, such as j, escape, or ctrl+c.")
const keybindingShape = Object.fromEntries(
  Object.entries(DEFAULT_KEYBINDINGS).map(([command, binding]) => [
    command,
    keybindingSchema.meta({ default: binding }),
  ]),
) as Record<XtuiCommandName, typeof keybindingSchema>

export const xtuiConfigFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    scrollbar: z
      .boolean()
      .optional()
      .describe("Show vertical scrollbars in timelines and comments.")
      .meta({ default: false }),
    keybindings: z.strictObject(keybindingShape).partial().optional().describe("Application command keybindings."),
  })
  .describe("xtui user configuration")

export const XTUI_CONFIG_JSON_SCHEMA = {
  $id: CONFIG_SCHEMA_URL,
  ...z.toJSONSchema(xtuiConfigFileSchema, { target: "draft-2020-12" }),
}

export const DEFAULT_CONFIG: XtuiConfig = {
  scrollbar: false,
  keybindings: { ...DEFAULT_KEYBINDINGS },
}

export function configFilePath(): string {
  const appData = process.env.APPDATA?.trim()
  if (process.platform === "win32" && appData) return join(appData, "xtui", "config.jsonc")

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
  const configHome = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(homedir(), ".config")
  return join(configHome, "xtui", "config.jsonc")
}

function defaultConfig(): XtuiConfig {
  return { scrollbar: DEFAULT_CONFIG.scrollbar, keybindings: { ...DEFAULT_KEYBINDINGS } }
}

function offsetLocation(text: string, offset: number): { line: number; column: number } {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/)
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

function issuePath(path: PropertyKey[]): string | undefined {
  return path.length > 0 ? `/${path.map(String).join("/")}` : undefined
}

export function loadConfig(path: string = configFilePath()): ConfigLoadResult {
  const config = defaultConfig()
  let text: string

  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config, issues: [], path }
    return {
      config,
      issues: [{ message: `Could not read the file: ${error instanceof Error ? error.message : String(error)}` }],
      path,
    }
  }

  const parseErrors: ParseError[] = []
  const input = text.trim() === "" ? {} : parse(text, parseErrors, { allowTrailingComma: true })
  if (parseErrors.length > 0) {
    return {
      config,
      issues: parseErrors.map((error) => ({
        message: printParseErrorCode(error.error),
        ...offsetLocation(text, error.offset),
      })),
      path,
    }
  }

  const result = xtuiConfigFileSchema.safeParse(input)
  if (result.success) {
    return {
      config: {
        scrollbar: result.data.scrollbar ?? config.scrollbar,
        keybindings: { ...config.keybindings, ...result.data.keybindings },
      },
      issues: [],
      path,
    }
  }

  const record = z.record(z.string(), z.unknown()).safeParse(input)
  if (record.success) {
    if (typeof record.data.scrollbar === "boolean") config.scrollbar = record.data.scrollbar

    const keybindings = z.record(z.string(), z.unknown()).safeParse(record.data.keybindings)
    if (keybindings.success) {
      for (const command of Object.keys(DEFAULT_KEYBINDINGS) as XtuiCommandName[]) {
        const binding = keybindingSchema.safeParse(keybindings.data[command])
        if (binding.success) config.keybindings[command] = binding.data
      }
    }
  }

  return {
    config,
    issues: result.error.issues.map((issue) => ({ message: issue.message, path: issuePath(issue.path) })),
    path,
  }
}

export function formatConfigIssue(filePath: string, issue: ConfigIssue): string {
  const location =
    issue.line !== undefined ? `:${issue.line}:${issue.column ?? 1}` : issue.path ? ` at ${issue.path}` : ""
  return `[xtui] Ignoring invalid config in ${filePath}${location}: ${issue.message}`
}
