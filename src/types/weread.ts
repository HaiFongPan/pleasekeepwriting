export interface WereadBook {
  bookId: string
  title: string
  author: string
  translator: string | null
  cover: string
  finishedAt: string | null
  rating: number | null
  deepLink: string
  intro: string | null
  category: string | null
  publisher: string | null
  publishTime: string | null
  isbn: string | null
  publicRating: number | null
  publicRatingCount: number | null
}

export interface WereadBooksData {
  generatedAt: string
  books: WereadBook[]
}
