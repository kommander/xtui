import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

const BROWSER_SOURCE_IDS = ["chrome", "brave", "edge", "firefox", "safari"] as const

export type BrowserSourceId = (typeof BROWSER_SOURCE_IDS)[number]

function preferencePath(): string {
  const appData = process.env.APPDATA?.trim()
  if (process.platform === "win32" && appData) return join(appData, "xtooey", "browser-source")

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim()
  const configHome = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(homedir(), ".config")
  return join(configHome, "xtooey", "browser-source")
}

export function loadRememberedBrowserSource(path: string = preferencePath()): BrowserSourceId | null {
  try {
    const value = readFileSync(path, "utf8").trim()
    return BROWSER_SOURCE_IDS.find((source) => source === value) ?? null
  } catch {
    return null
  }
}

export function rememberBrowserSource(source: BrowserSourceId | null, path: string = preferencePath()): void {
  try {
    if (source === null) {
      rmSync(path, { force: true })
      return
    }

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${source}\n`, { encoding: "utf8", mode: 0o600 })
  } catch {
    // A read-only config directory should not prevent the user from connecting.
  }
}
