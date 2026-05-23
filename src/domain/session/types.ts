// Agent session — domain type shared across extensions and frontends.

export interface Session {
  id: string
  rootMessageId: string
  createdAt: string
  updatedAt: string
}
