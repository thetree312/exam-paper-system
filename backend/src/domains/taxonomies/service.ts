import { createID } from "../../lib/ids"
import { TaxonomyRepository } from "./repository"
import { type TaxonomyKind } from "./types"

function normalizeName(name: string) {
  const normalized = name.trim()
  if (!normalized) {
    throw new Error("Name is required")
  }
  if (normalized.length > 100) {
    throw new Error("Name must be at most 100 characters")
  }
  return normalized
}

export const TaxonomyService = {
  async list(input: { userID: string; kind: TaxonomyKind }) {
    return TaxonomyRepository.listByUserAndKind(input)
  },

  async getOrCreate(input: { userID: string; kind: TaxonomyKind; name: string }) {
    const normalizedName = normalizeName(input.name)
    const existing = await TaxonomyRepository.findByUserKindAndName({
      userID: input.userID,
      kind: input.kind,
      name: normalizedName,
    })
    if (existing) {
      return existing
    }

    const now = new Date().toISOString()
    return TaxonomyRepository.insert({
      id: createID(input.kind.replace(/[^a-z]/g, "_")),
      userID: input.userID,
      kind: input.kind,
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
    })
  },
}
