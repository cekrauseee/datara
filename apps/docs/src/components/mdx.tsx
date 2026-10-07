import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import Link from 'next/link'

export function getMDXComponents(locale: string, components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    a: ({ href = '', ...props }) => (
      <Link
        href={href.startsWith('/') && !href.startsWith('//') ? `/${locale}${href}` : href}
        {...props}
      />
    ),
    ...components,
  }
}
