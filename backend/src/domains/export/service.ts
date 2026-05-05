import type { ExportTemplateInfo, ExportWordInput } from "./types"
import { ExportTemplatesService } from "./templates-service"
import { ExportWordService } from "./word-export-service"

export const ExportDomainService = {
  listTemplates(): Promise<ExportTemplateInfo[]> {
    return ExportTemplatesService.list()
  },

  exportWord(input: ExportWordInput) {
    return ExportWordService.export(input)
  },
}
