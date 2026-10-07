import type { MetadataRoute } from 'next'
import { source } from '../lib/source'

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = process.env.DOCS_ORIGIN ?? 'http://localhost:3002'
  return source.getPages().map((page) => ({
    url: new URL(page.url, origin).href,
    alternates: {
      languages: Object.fromEntries(
        source
          .getLanguages()
          .map(({ language }) => [
            language,
            new URL(source.getPage(page.slugs, language)!.url, origin).href,
          ]),
      ),
    },
  }))
}
