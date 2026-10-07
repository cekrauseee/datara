import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { OpenAPIPage } from '../../../components/api-page'
import { getMDXComponents } from '../../../components/mdx'
import { openapi } from '../../../lib/openapi'
import { source } from '../../../lib/source'

export function generateStaticParams() {
  return source.generateParams()
}

type Props = { params: Promise<{ lang: string; slug?: string[] }> }
export default async function Page({ params }: Props) {
  const { lang, slug } = await params
  const page = source.getPage(slug, lang)
  if (!page) notFound()
  const Body = page.data.body
  const preloaded = await openapi.preloadOpenAPIPage(page)
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <Body
          components={getMDXComponents(lang, {
            OpenAPIPage: (props) => <OpenAPIPage {...preloaded} {...props} />,
          })}
        />
      </DocsBody>
    </DocsPage>
  )
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, slug } = await params
  const page = source.getPage(slug, lang)
  if (!page)
    return {
      title: lang === 'pt' ? 'Página não encontrada' : 'Page not found',
      robots: { index: false },
    }
  return {
    title: `${page.data.title} · Datara`,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      languages: { en: source.getPage(slug, 'en')!.url, pt: source.getPage(slug, 'pt')!.url },
    },
  }
}
