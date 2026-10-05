import config from '@datara/prettier'

export default {
  ...config,
  plugins: [...config.plugins, import.meta.resolve('prettier-plugin-tailwindcss')],
  tailwindStylesheet: './src/index.css',
}
