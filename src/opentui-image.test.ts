import { describe, expect, test } from "bun:test"
import { BoxRenderable, CliRenderEvents, ImageRenderable, NativeImage, type CliRendererErrorEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

const RED_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
    "base64",
  ),
)
const ICC_PALETTE_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAMAAAAsPuSGAAABYGlDQ1BpY2MAACiRdZE/SMNAFMa//pEWW1Chg4NDBxWHFtQW7KCg7VCQIjUqqLgk1zQVkjRcUqSzi6Pg6qI4i47FoY7dBV1Ed3EQBBcp5zsjtoh9x9378XHf4907IJgzmeWGlwHL9rhSzCe3d3aTkRdEEUICc8iqzHVWyuUSBsbHPQIy36VlrcH3/o1YRXcZEIgSZ5nDPeJF4tKB50g+Ik6wmlohPiVOcWqQuCN1zedHyYbPb5L5plIAgmHiUaOPtT5mNW4RJ4gnLbPBfvqRL4nr9tYG5XHaE1BQRB5JaGhgHyY8pCnbAzyz35411MnB6HTQBKf7BmrkTJHagAudcpV0nZaJppz531m61cy8Xz2eB4aehHifAiInQPdYiM8zIbrnQIjefmv3/IfPwFJbCHHT02ZywFgM6LR62mobuF4AhluOytXf3whmMv5cKELyuKT5rL8ChQfg6gKYrgIje1/MKWVoGIVbZwAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAACVBMVEXIHigoyDxkeIzRTiAjAAAADElEQVQI12NgYGQCAAAIAATnw6/5AAAAAElFTkSuQmCC",
    "base64",
  ),
)

describe("OpenTUI 0.5.1 image regressions", () => {
  test("decodes a PNG with trailing ASCII whitespace", () => {
    const padded = new Uint8Array(RED_PNG.length + 4)
    padded.set(RED_PNG)
    padded.set([32, 9, 10, 13], RED_PNG.length)

    const image = NativeImage.decode(padded)
    try {
      expect(image.info()).toMatchObject({ format: "png", width: 1, height: 1 })
      expect(image.raw().data).toEqual(Uint8Array.from([255, 0, 0, 255]))
    } finally {
      image.dispose()
    }
  })

  test("materializes an ICC palette PNG as explicit sRGB", () => {
    const image = NativeImage.decode(ICC_PALETTE_PNG)
    try {
      expect(image.info()).toMatchObject({
        format: "png",
        colorStatus: "explicit-srgb",
        width: 3,
        height: 1,
      })
      expect(image.raw().data).toHaveLength(12)
    } finally {
      image.dispose()
    }
  })

  test("renders padded and ICC PNGs through ImageRenderable blocks", async () => {
    const setup = await createTestRenderer({ width: 12, height: 4 })
    const errors: Error[] = []
    setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) => errors.push(event.error))
    const padded = new Uint8Array(RED_PNG.length + 1)
    padded.set(RED_PNG)
    padded[RED_PNG.length] = 32
    const row = new BoxRenderable(setup.renderer, { width: 6, height: 1, flexDirection: "row" })
    const paddedImage = new ImageRenderable(setup.renderer, {
      source: padded,
      width: 2,
      height: 1,
      protocol: "blocks",
    })
    const iccImage = new ImageRenderable(setup.renderer, {
      source: ICC_PALETTE_PNG,
      width: 3,
      height: 1,
      protocol: "blocks",
    })
    row.add(paddedImage)
    row.add(iccImage)
    setup.renderer.root.add(row)

    try {
      await Promise.all([paddedImage.loadPromise, iccImage.loadPromise])
      await setup.renderOnce()
      expect(paddedImage.loadError).toBeNull()
      expect(iccImage.loadError).toBeNull()
      expect(errors).toEqual([])
    } finally {
      setup.renderer.destroy()
    }
  })
})
