import type { Document } from 'fumadocs-openapi'
import { createOpenAPI } from 'fumadocs-openapi/server'
import portuguese from '../../../../docs/site/api/reference-translations.json'
import document from '../../.generated/openapi.json'

function translate(text: string) {
  const translated = portuguese[text as keyof typeof portuguese]
  if (!translated) throw new Error(`Missing Portuguese OpenAPI translation: ${text}`)
  return translated
}

const localized = structuredClone(document)
for (const path of Object.values(localized.paths)) {
  const operation = path.get
  operation.summary = translate(operation.summary)
  for (const response of Object.values(operation.responses)) {
    response.description = translate(response.description)
  }
}
// Fumadocs accepts OpenAPI 3.1 input and upgrades it; its Document type describes the 3.2 output.
const servers = [{ url: 'http://localhost:3000', description: 'Local development' }]
export const openapi = createOpenAPI({
  input: {
    datara: { ...document, servers } as unknown as Document,
    'datara-pt': { ...localized, servers } as unknown as Document,
  },
})
