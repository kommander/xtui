import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageJson from "../package.json" with { type: "json" }

const directory = mkdtempSync(join(tmpdir(), "xtooey-package-smoke-"))
const installDirectory = join(directory, "install")
const npm = process.platform === "win32" ? "npm.cmd" : "npm"

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" })
  if (result.status === 0) return
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  throw new Error(`${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`)
}

try {
  mkdirSync(installDirectory)
  writeFileSync(join(installDirectory, "package.json"), '{"name":"xtooey-smoke","private":true}\n')
  run(npm, ["pack", "--pack-destination", directory], process.cwd())

  const tarball = join(directory, `${packageJson.name}-${packageJson.version}.tgz`)
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`)
  run(npm, ["install", tarball, "--no-audit", "--no-fund"], installDirectory)

  const installedManifest = JSON.parse(
    readFileSync(join(installDirectory, "node_modules", packageJson.name, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown; bin?: Record<string, string> }
  if (installedManifest.name !== packageJson.name || installedManifest.version !== packageJson.version) {
    throw new Error(`Installed ${String(installedManifest.name)}@${String(installedManifest.version)}`)
  }
  if (installedManifest.bin?.xtooey !== "src/index.ts") throw new Error("Installed package is missing the xtooey bin")

  const bin = join(installDirectory, "node_modules", ".bin", process.platform === "win32" ? "xtooey.cmd" : "xtooey")
  if (!existsSync(bin)) throw new Error(`npm did not create the CLI shim at ${bin}`)
  run(process.execPath, ["-e", 'await import("./node_modules/xtooey/src/index.ts")'], installDirectory)
  console.log(`Verified ${packageJson.name}@${packageJson.version} from a clean npm install`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
