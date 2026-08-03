import { ImageLoadError } from "@opentui/core"

const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

type ImageKind = "avatar" | "media"
type ImageFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function xImageUrl(source: string, kind: ImageKind): string {
  return xImageUrls(source, kind)[0]!
}

export function xImageUrls(source: string, kind: ImageKind): string[] {
  if (kind !== "media" || !URL.canParse(source)) return [source]
  const url = new URL(source)
  if (url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/")) return [source]

  url.protocol = "https:"
  url.pathname = url.pathname
    .replace(/:(?:thumb|small|medium|large|orig|4096x4096)$/i, "")
    .replace(/\.(?:jpe?g|png|webp|gif)$/i, "")
  url.search = ""
  url.hash = ""
  url.searchParams.set("format", "webp")
  url.searchParams.set("name", "small")
  const webp = url.href
  url.searchParams.set("format", "jpg")
  return [webp, source, url.href]
}

export function trimPngTrailingWhitespace(data: Uint8Array): Uint8Array {
  if (data.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, index) => data[index] !== byte)) return data

  let offset: number = PNG_SIGNATURE.length
  while (offset + 12 <= data.length) {
    const length = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0)
    if (length > data.length - offset - 12) return data
    const chunkEnd = offset + 12 + length
    const isIend =
      data[offset + 4] === 73 && data[offset + 5] === 69 && data[offset + 6] === 78 && data[offset + 7] === 68
    if (isIend) {
      if (length !== 0) return data
      const trailing = data.subarray(chunkEnd)
      if (trailing.length === 0) return data
      if (!trailing.every((byte) => byte === 9 || byte === 10 || byte === 13 || byte === 32)) return data
      return data.subarray(0, chunkEnd)
    }
    offset = chunkEnd
  }
  return data
}

export async function fetchXImageBytes(
  source: string,
  signal?: AbortSignal,
  fetchImage: ImageFetch = fetch,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<Uint8Array> {
  const response = await fetchImage(source, { signal })
  if (!response.ok) {
    await response.body?.cancel()
    throw new ImageLoadError("http-status", source, `Failed to load image: HTTP ${response.status}`, {
      status: response.status,
    })
  }
  const contentLengthHeader = response.headers.get("content-length")
  const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel()
    throw new ImageLoadError("network", source, "Image exceeds the 64 MiB encoded size limit.")
  }

  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let bytes = Number.isInteger(contentLength) && contentLength >= 0 ? new Uint8Array(contentLength) : null
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.byteLength > maxBytes) {
        await reader.cancel()
        throw new ImageLoadError("network", source, "Image exceeds the 64 MiB encoded size limit.")
      }
      if (bytes && total + value.byteLength <= bytes.byteLength) bytes.set(value, total)
      else {
        if (bytes) {
          chunks.push(bytes.subarray(0, total))
          bytes = null
        }
        chunks.push(value)
      }
      total += value.byteLength
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (signal?.aborted) throw signal.reason
    throw error
  }

  if (!bytes) {
    bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
  } else if (total !== bytes.byteLength) {
    bytes = bytes.slice(0, total)
  }
  return trimPngTrailingWhitespace(bytes)
}
