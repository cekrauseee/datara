import tseslint from 'typescript-eslint'

export default (tsconfigRootDir) => [
  { ignores: ['dist/**', 'node_modules/**', '.turbo/**'] },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: { 'no-unused-vars': 'error' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
]
