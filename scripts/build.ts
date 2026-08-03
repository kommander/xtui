import { mkdir } from "node:fs/promises"

const target = process.argv[2] as Bun.Build.CompileTarget | undefined
const hostPlatform = process.platform === "win32" ? "windows" : process.platform
const targetId = target?.replace(/^bun-/, "") ?? `${hostPlatform}-${process.arch}`
const isWindows = targetId.startsWith("windows-")
const isLinux = targetId.startsWith("linux-")
const libc = targetId.includes("musl") ? "musl" : "glibc"
const outfile = `dist/xtui-${targetId}${isWindows ? ".exe" : ""}`

await mkdir("dist", { recursive: true })

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  format: "esm",
  minify: true,
  sourcemap: "linked",
  compile: {
    ...(target ? { target } : {}),
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  ...(isLinux
    ? {
        define: {
          "process.env.OPENTUI_LIBC": JSON.stringify(libc),
        },
      }
    : {}),
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("Failed to build xtui")
}

console.log(`Built ${outfile}`)
