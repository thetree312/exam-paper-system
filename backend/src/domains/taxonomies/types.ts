export type TaxonomyKind = 'subject' | 'tag' | 'question-type'

export type TaxonomyRecord = {
  id: string
  userID: string
  kind: TaxonomyKind
  name: string
  createdAt: string
  updatedAt: string
}

export type TaxonomyState = {
  items: TaxonomyRecord[]
}
