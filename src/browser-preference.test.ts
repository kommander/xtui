import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadRememberedBrowserSource, rememberBrowserSource, type BrowserSourceId } from "./browser-preference.js"

const directories: string[] = []

function preferenceFile(): string {
  const directory = mkdtempSync(join(process.cwd(), ".xtui-preference-test-"))
  directories.push(directory)
  return join(directory, "nested", "browser-source")
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("browser preference", () => {
  test.each<BrowserSourceId>(["chrome", "brave", "edge", "firefox", "safari"])("remembers %s", (source) => {
    const path = preferenceFile()

    rememberBrowserSource(source, path)

    expect(loadRememberedBrowserSource(path)).toBe(source)
  })

  test("clears the remembered browser", () => {
    const path = preferenceFile()
    rememberBrowserSource("firefox", path)

    rememberBrowserSource(null, path)

    expect(loadRememberedBrowserSource(path)).toBeNull()
  })

  test("ignores unknown values", () => {
    const path = preferenceFile()
    rememberBrowserSource("chrome", path)
    writeFileSync(path, "unknown\n")

    expect(loadRememberedBrowserSource(path)).toBeNull()
  })
})
