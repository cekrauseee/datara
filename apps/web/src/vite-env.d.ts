/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute origin of the elections API. `pnpm dev` derives it from the API `PORT`. */
  readonly VITE_API_URL?: string
}
