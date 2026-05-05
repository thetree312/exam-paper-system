import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createID } from "../../lib/ids"
import { cropImageToFile, imageFileToDataUrl } from "../../lib/image-processing"
import { OcrProviderClient } from "../ocr/provider-client"
import type { DocumentRecord } from "../documents/service"
import type { StudioLegendRegion, StudioSelectionRegion } from "./types"

type SelectionResolvedBox = {
  x1: number
  y1: number
  x2: number
  y2: number
}

type SelectionResolvedRegion = {
  page: number
  region: StudioSelectionRegion
  cropPath: string
  text: string
}

function assertNormalizedNumber(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a normalized number between 0 and 1`)
  }
  return value
}

function resolveAbsoluteBox(input: {
  width: number | null
  height: number | null
  x: number
  y: number
  widthNorm: number
  heightNorm: number
}) {
  if (!input.width || !input.height) throw new Error("Page dimensions are unavailable")
  const x = Math.round(assertNormalizedNumber(input.x, "x") * input.width)
  const y = Math.round(assertNormalizedNumber(input.y, "y") * input.height)
  const width = Math.round(assertNormalizedNumber(input.widthNorm, "width") * input.width)
  const height = Math.round(assertNormalizedNumber(input.heightNorm, "height") * input.height)
  if (width <= 0 || height <= 0) throw new Error("Selection width/height must be greater than zero")
  return {
    x1: x,
    y1: y,
    x2: x + width,
    y2: y + height,
  } satisfies SelectionResolvedBox
}

async function callCloudOcr(input: { userID: string; imagePath: string }) {
  return OcrProviderClient.recognizeSelection(input)
}

async function cropSelectionRegion(input: {
  document: DocumentRecord
  region: StudioSelectionRegion
  cropDirectory: string
  filenamePrefix: string
}) {
  const page = input.document.layoutPages.find((item) => item.pageNumber === input.region.page)
  if (!page) throw new Error(`Document layout page not found: ${input.document.id}#${input.region.page}`)
  const previewPage = input.document.previewPages.find((item) => item.pageNumber === input.region.page)
  if (!previewPage) throw new Error(`Document preview page not found: ${input.document.id}#${input.region.page}`)

  const bboxAbs = resolveAbsoluteBox({
    width: page.width,
    height: page.height,
    x: input.region.x,
    y: input.region.y,
    widthNorm: input.region.width,
    heightNorm: input.region.height,
  })

  const exclusionBoxesAbs = (input.region.exclusions ?? []).map((item) =>
    resolveAbsoluteBox({
      width: page.width,
      height: page.height,
      x: item.x,
      y: item.y,
      widthNorm: item.width,
      heightNorm: item.height,
    }),
  )

  const cropPath = path.join(input.cropDirectory, `${input.filenamePrefix}-page-${input.region.page}-${createID("crop")}.png`)
  await cropImageToFile({
    sourceImagePath: previewPage.absolutePath,
    destinationPath: cropPath,
    bboxAbs,
    exclusionBoxesAbs,
  })

  return {
    page,
    previewPage,
    bboxAbs,
    cropPath,
  }
}

async function cropLegend(input: {
  document: DocumentRecord
  legend: StudioLegendRegion
  cropDirectory: string
  filenamePrefix: string
}) {
  const page = input.document.layoutPages.find((item) => item.pageNumber === input.legend.page)
  if (!page) throw new Error(`Document layout page not found: ${input.document.id}#${input.legend.page}`)
  const previewPage = input.document.previewPages.find((item) => item.pageNumber === input.legend.page)
  if (!previewPage) throw new Error(`Document preview page not found: ${input.document.id}#${input.legend.page}`)

  const bboxAbs = resolveAbsoluteBox({
    width: page.width,
    height: page.height,
    x: input.legend.x,
    y: input.legend.y,
    widthNorm: input.legend.width,
    heightNorm: input.legend.height,
  })

  const cropPath = path.join(input.cropDirectory, `${input.filenamePrefix}-legend-page-${input.legend.page}-${createID("legend")}.png`)
  await cropImageToFile({
    sourceImagePath: previewPage.absolutePath,
    destinationPath: cropPath,
    bboxAbs,
  })
  return imageFileToDataUrl(cropPath)
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")

export const StudioOcrService = {
  async recognizeSelection(input: {
    document: DocumentRecord
    regions: StudioSelectionRegion[]
    legends: StudioLegendRegion[]
  }) {
    if (input.regions.length === 0) throw new Error("regions is required")

    const cropDirectory = path.join(backendRoot, "local-data", "studio", "crops", input.document.id)
    await mkdir(cropDirectory, { recursive: true })

    const recognizedRegions: SelectionResolvedRegion[] = []
    for (let index = 0; index < input.regions.length; index += 1) {
      const region = input.regions[index]
      const cropped = await cropSelectionRegion({
        document: input.document,
        region,
        cropDirectory,
        filenamePrefix: `selection-${index}`,
      })
      const ocr = await callCloudOcr({
        userID: input.document.userID,
        imagePath: cropped.cropPath,
      })
      recognizedRegions.push({
        page: region.page,
        region,
        cropPath: cropped.cropPath,
        text: ocr.text,
      })
    }

    const legendImages: string[] = []
    for (let index = 0; index < input.legends.length; index += 1) {
      legendImages.push(
        await cropLegend({
          document: input.document,
          legend: input.legends[index],
          cropDirectory,
          filenamePrefix: `selection-${index}`,
        }),
      )
    }

    const text = recognizedRegions
      .sort((left, right) => left.page - right.page)
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim()

    if (!text) throw new Error("Selection OCR returned empty text")

    return {
      text,
      legendImages,
      recognizedRegions,
    }
  },
}
