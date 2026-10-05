import type { MapWorkerRequest } from './map-worker-types'

let worker: Worker | undefined
let sequence = 0
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }
>()

export function mapWorker<T>(request: MapWorkerRequest, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (!worker) {
    try {
      worker = new Worker(new URL('./map-worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      return Promise.reject(error)
    }
    worker.onmessage = ({
      data,
    }: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
      const task = pending.get(data.id)
      if (!task) return
      pending.delete(data.id)
      task.cleanup()
      if (data.error) task.reject(new Error(data.error))
      else task.resolve(data.value)
    }
    worker.onerror = () => {
      for (const task of pending.values()) {
        task.cleanup()
        task.reject(new Error('Map preparation failed'))
      }
      pending.clear()
      worker?.terminate()
      worker = undefined
    }
  }
  const id = ++sequence
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      pending.delete(id)
      worker?.postMessage({ cancel: id })
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      cleanup: () => signal?.removeEventListener('abort', abort),
    })
    worker!.postMessage({ id, request })
  })
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    worker?.terminate()
    for (const task of pending.values()) {
      task.cleanup()
      task.reject(new Error('Map worker reloaded'))
    }
    pending.clear()
  })
