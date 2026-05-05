export type FavoriteRecord = {
  id: string
  userID: string
  questionID: string
  questionTypeID?: string | null
  subjectID?: string | null
  tagIDs: string[]
  createdAt: string
  updatedAt: string
}

export type FavoritesState = {
  items: FavoriteRecord[]
}

