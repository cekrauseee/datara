import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Provider } from '../../components/provider'
import { source } from '../../lib/source'
import '../global.css'

export const metadata: Metadata = {
  metadataBase: new URL(process.env.DOCS_ORIGIN ?? 'http://localhost:3002'),
}

export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ lang: string }>
  children: ReactNode
}) {
  const { lang } = await params
  if (lang !== 'pt' && lang !== 'en') notFound()
  return (
    <html lang={lang} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider locale={lang}>
          <DocsLayout
            tree={source.getPageTree(lang)}
            nav={{ title: 'Datara', url: `/${lang}` }}
            themeSwitch={{ enabled: false }}
            sidebar={{
              footer: (
                <ThemeSwitch
                  mode="light-dark-system"
                  className="w-fit"
                  role="group"
                  aria-label={lang === 'pt' ? 'Tema' : 'Theme'}
                />
              ),
            }}
          >
            {children}
          </DocsLayout>
        </Provider>
      </body>
    </html>
  )
}
