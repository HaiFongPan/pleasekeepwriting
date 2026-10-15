import { bindings, defineConfig } from 'cf/config'

export default defineConfig({
  accountId: 'c902c333de0a4efbc67f3315698dd3b8',
  worker: {
    name: 'workout-upload',
    entrypoint: './src/index.mjs',
    compatibilityDate: '2026-10-15',
    compatibilityFlags: ['nodejs_compat'],
    workersDev: true,
    previewUrls: false,
    observability: { enabled: false },
    env: {
      ARCHIVE: bindings.r2({ name: 'workout-archive' }),
      UPLOAD_TOKEN: bindings.secret(),
      REQUEST_LIMITER: bindings.rateLimit({
        namespace: '2026101501',
        simple: { limit: 30, period: 60 },
      }),
      UPLOAD_LIMITER: bindings.rateLimit({
        namespace: '2026101502',
        simple: { limit: 10, period: 60 },
      }),
    },
  },
})
