import config from '@datara/eslint'

export default [
  { ignores: ['.next/**', '.source/**', '.generated/**', 'next-env.d.ts'] },
  ...config(import.meta.dirname),
]
