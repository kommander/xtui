import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_CONFIG,
  DEFAULT_KEYBINDINGS,
  XTUI_CONFIG_JSON_SCHEMA,
  formatConfigIssue,
  loadConfig,
} from "./config.js"

const directories: string[] = []

function configFile(contents?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "xtui-config-test-"))
  directories.push(directory)
  const path = join(directory, "config.jsonc")
  if (contents !== undefined) writeFileSync(path, contents)
  return path
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("configuration", () => {
  test("uses defaults when the file does not exist", () => {
    const result = loadConfig(configFile())

    expect(result.config).toEqual(DEFAULT_CONFIG)
    expect(result.issues).toEqual([])
  })

  test("loads comments, trailing commas, scrollbars, and keybindings", () => {
    const result = loadConfig(
      configFile(`{
        // JSON is also valid here.
        "scrollbar": true,
        "keybindings": {
          "x.feed.next": "down",
          "app.quit": "q",
        },
      }`),
    )

    expect(result.issues).toEqual([])
    expect(result.config.scrollbar).toBe(true)
    expect(result.config.keybindings["x.feed.next"]).toBe("down")
    expect(result.config.keybindings["app.quit"]).toBe("q")
    expect(result.config.keybindings["x.feed.previous"]).toBe(DEFAULT_KEYBINDINGS["x.feed.previous"])
  })

  test("ignores invalid fields while preserving valid siblings", () => {
    const result = loadConfig(
      configFile(`{
        "scrollbar": "yes",
        "unknown": true,
        "keybindings": {
          "x.feed.next": "down",
          "x.feed.previous": "",
          "x.feed.missing": "m"
        }
      }`),
    )

    expect(result.issues).toHaveLength(4)
    expect(result.config.scrollbar).toBe(false)
    expect(result.config.keybindings["x.feed.next"]).toBe("down")
    expect(result.config.keybindings["x.feed.previous"]).toBe(DEFAULT_KEYBINDINGS["x.feed.previous"])
  })

  test("reports malformed JSONC with its location", () => {
    const result = loadConfig(configFile("{\n  scrollbar: true\n}"))

    expect(result.config).toEqual(DEFAULT_CONFIG)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(formatConfigIssue(result.path, result.issues[0]!)).toContain(`${result.path}:2:3`)
  })

  test.each(["z", "escape", "Escape"])("rejects unsafe global bindings key %s", (binding) => {
    const result = loadConfig(configFile(JSON.stringify({ keybindings: { "app.bindings": binding } })))

    expect(result.issues).toHaveLength(1)
    expect(result.config.keybindings["app.bindings"]).toBe(DEFAULT_KEYBINDINGS["app.bindings"])
  })

  test("keeps the checked-in JSON Schema synchronized", () => {
    const checkedIn = JSON.parse(readFileSync(join(import.meta.dir, "..", "xtui.schema.json"), "utf8"))
    expect(checkedIn).toEqual(XTUI_CONFIG_JSON_SCHEMA)
  })
})
