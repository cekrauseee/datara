import { defineConfig, defineDocs } from 'fumadocs-mdx/config'

export const docs = defineDocs({ dir: '../../docs/site', meta: { files: ['**/meta*.json'] } })
export const reference = defineDocs({ dir: '.generated/reference' })
export default defineConfig()
