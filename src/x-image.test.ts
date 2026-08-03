import { describe, expect, test } from "bun:test"
import { imageInfo } from "@opentui/core"
import { fetchXImageBytes, trimPngTrailingWhitespace, xImageUrl, xImageUrls } from "./x-image.js"

const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
)

describe("X image loading", () => {
  test("requests X media as small WebP with JPEG and original fallbacks", () => {
    expect(xImageUrl("https://pbs.twimg.com/media/HOz3-y4WQAAIc6A.png:small", "media")).toBe(
      "https://pbs.twimg.com/media/HOz3-y4WQAAIc6A?format=webp&name=small",
    )
    expect(xImageUrl("https://pbs.twimg.com/media/id?format=png&name=large", "media")).toBe(
      "https://pbs.twimg.com/media/id?format=webp&name=small",
    )
    expect(xImageUrls("https://pbs.twimg.com/media/example.png:small", "media")).toEqual([
      "https://pbs.twimg.com/media/example?format=webp&name=small",
      "https://pbs.twimg.com/media/example.png:small",
      "https://pbs.twimg.com/media/example?format=jpg&name=small",
    ])
  })

  test("does not apply media transforms to avatars or other hosts", () => {
    const avatar = "https://pbs.twimg.com/profile_images/1/avatar_normal.png"
    const other = "https://example.com/media/photo.png"
    expect(xImageUrl(avatar, "avatar")).toBe(avatar)
    expect(xImageUrl(other, "media")).toBe(other)
  })

  test("trims only whitespace after a complete PNG IEND chunk", () => {
    const padded = new Uint8Array(PNG.length + 5)
    padded.set(PNG)
    padded.fill(32, PNG.length)
    const trimmed = trimPngTrailingWhitespace(padded)
    expect(trimmed.byteLength).toBe(PNG.byteLength)
    expect(imageInfo(trimmed).format).toBe("png")

    const nonWhitespace = new Uint8Array(PNG.length + 1)
    nonWhitespace.set(PNG)
    nonWhitespace[PNG.length] = 1
    expect(trimPngTrailingWhitespace(nonWhitespace)).toBe(nonWhitespace)
  })

  test("loads and sanitizes an avatar before native decoding", async () => {
    const padded = new Uint8Array(PNG.length + 3)
    padded.set(PNG)
    padded.fill(32, PNG.length)
    const requested: string[] = []
    const bytes = await fetchXImageBytes(
      "https://pbs.twimg.com/profile_images/1/avatar_normal.png",
      undefined,
      async (input) => {
        requested.push(String(input))
        return new Response(padded, { status: 200 })
      },
    )
    expect(requested).toEqual(["https://pbs.twimg.com/profile_images/1/avatar_normal.png"])
    expect(bytes.byteLength).toBe(PNG.byteLength)
  })

  test("cancels an unknown-length response as soon as it exceeds the byte limit", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4))
        controller.enqueue(new Uint8Array(4))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(
      fetchXImageBytes("https://example.com/image.png", undefined, async () => new Response(body), 6),
    ).rejects.toThrow("64 MiB")
    expect(cancelled).toBe(true)
  })
})
