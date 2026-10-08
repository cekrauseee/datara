import { openapiTranslations } from 'fumadocs-openapi/i18n'
import { uiTranslations } from 'fumadocs-ui/i18n'
import { i18n } from './i18n'
import portuguese from './pt.json'

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .extend(openapiTranslations())
  .add({
    en: { displayName: 'English' },
    pt: portuguese,
  })
