import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware'
import type { NextFetchEvent, NextRequest } from 'next/server'
import { i18n } from './lib/i18n'

const negotiate = createI18nMiddleware(i18n)
export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const response = await negotiate(request, event)
  if (response?.headers.has('location')) response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export const config = { matcher: ['/((?!api/search(?:/|$)|_next|.*\\..*).*)'] }
