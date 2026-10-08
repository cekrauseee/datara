'use client'

import { useI18n } from 'fumadocs-ui/contexts/i18n'
import Link from 'next/link'

export default function NotFound() {
  const { locale } = useI18n()
  const portuguese = locale === 'pt'
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">
        {portuguese ? 'Página não encontrada' : 'Page not found'}
      </h1>
      <p className="my-4">
        {portuguese
          ? 'Confira o endereço ou use a busca para encontrar um guia.'
          : 'Check the address or use search to find a guide.'}
      </p>
      <Link className="underline" href={`/${locale ?? 'pt'}`}>
        {portuguese ? 'Voltar ao início' : 'Back to home'}
      </Link>
    </main>
  )
}
