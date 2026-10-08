import config from '@datara/eslint'

export default [{ ignores: ['.generated/**'] }, ...config(import.meta.dirname)]
