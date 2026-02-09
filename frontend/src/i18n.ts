import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import enCommon from './locales/en/common.json'
import zhCommon from './locales/zh/common.json'

const UI_LANG_STORAGE_KEY = 'ui-lang'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon },
      zh: { common: zhCommon },
    },
    fallbackLng: 'zh',
    supportedLngs: ['zh', 'en'],
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: UI_LANG_STORAGE_KEY,
    },
  })

export { UI_LANG_STORAGE_KEY }
export default i18n
