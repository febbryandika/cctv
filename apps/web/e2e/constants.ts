// Shared by playwright.config.ts and the auth setup, so the path is written
// once. e2e/.auth/ is gitignored: it holds a real session cookie.
export const AUTH_FILE = 'e2e/.auth/operator.json'

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
