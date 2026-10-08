import { loader } from 'fumadocs-core/source'
import { docs, reference } from '../../.source/server'
import { i18n } from './i18n'
import { openapi } from './openapi'

export const source = loader({
  baseUrl: '/',
  i18n,
  source: { docs: docs.toFumadocsSource(), reference: reference.toFumadocsSource() },
  plugins: [openapi.loaderPlugin()],
})
