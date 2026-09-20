import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { PluginFileHandle } from '@valley/plugin-sdk/pluginNative'

interface ModelSource { url: string; name: string; sha256: string }
interface Waiter { resolve(value: PluginFileHandle): void; reject(error: unknown): void; progress(percent: number): void }
interface Entry {
  requestId: string
  waiters: Set<Waiter>
  pending: Promise<void>
  cancelled: boolean
  value?: PluginFileHandle
  cancellation?: Promise<void>
}

const cancelled = (): Error => Object.assign(new Error('Model download cancelled'), { name: 'AbortError' })

export function createModelCache(api: PluginBackendApi, sources: Record<string, ModelSource>) {
  const entries = new Map<string, Entry>()
  const handles = new Set<string>()
  let closing = false
  let disposal: Promise<void> | undefined
  const offProgress = api.network.onProgress(({ requestId, phase, bytes, total }) => {
    if (phase !== 'download' || !total) return
    const entry = [...entries.values()].find(value => value.requestId === requestId)
    if (!entry || entry.cancelled) return
    for (const waiter of entry.waiters) waiter.progress(Math.min(100, bytes / total * 100))
  })
  const cancelEntry = (entry: Entry): Promise<void> => {
    entry.cancelled = true
    entry.cancellation ??= (async () => {
      const results = await Promise.allSettled([api.network.cancel(entry.requestId), entry.pending])
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return entry.cancellation
  }
  const start = (model: string, source: ModelSource): Entry => {
    const entry: Entry = { requestId: `model:${model}:${crypto.randomUUID()}`, waiters: new Set(), pending: Promise.resolve(), cancelled: false }
    entries.set(model, entry)
    entry.pending = Promise.resolve().then(async () => {
      let value: PluginFileHandle | null = null
      try {
        value = await api.files.cached({ sha256: source.sha256, name: source.name })
        if (entry.cancelled) throw cancelled()
        if (!value) {
          for (const waiter of entry.waiters) waiter.progress(0)
          value = await api.network.download({ requestId: entry.requestId, url: source.url, name: source.name, sha256: source.sha256, maxBytes: 4 * 1024 ** 3 })
        }
        if (entry.cancelled) throw cancelled()
        entry.value = value
        handles.add(value.handle)
        for (const waiter of entry.waiters) waiter.resolve(value)
      } catch (error) {
        let failure = error
        try { if (value) await api.files.release([value.handle]) }
        catch (cleanupError) { failure = new AggregateError([error, cleanupError], 'Model download cleanup failed') }
        for (const waiter of entry.waiters) waiter.reject(failure)
        if (failure !== error) throw failure
      } finally {
        entry.waiters.clear()
        if (!entry.value && entries.get(model) === entry) entries.delete(model)
      }
    })
    void entry.pending.catch(() => {})
    return entry
  }
  const acquire = (model: string, progress: (percent: number) => void) => {
    const source = sources[model]
    if (closing || !source) throw cancelled()
    let entry = entries.get(model)
    if (entry?.cancelled) throw cancelled()
    entry ??= start(model, source)
    if (entry.value) return { result: Promise.resolve(entry.value), cancel: () => Promise.resolve() }
    const current = entry
    let waiter!: Waiter
    let cancelPromise: Promise<void> | undefined
    const result = new Promise<PluginFileHandle>((resolve, reject) => {
      waiter = { resolve, reject, progress }
      current.waiters.add(waiter)
    })
    return {
      result,
      cancel: (): Promise<void> => {
        if (cancelPromise) return cancelPromise
        if (!current.waiters.delete(waiter)) return current.pending
        waiter.reject(cancelled())
        cancelPromise = !current.waiters.size && !current.value ? cancelEntry(current) : Promise.resolve()
        return cancelPromise
      }
    }
  }
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    closing = true
    const pending = [...entries.values()].filter(entry => !entry.value)
    for (const entry of pending) {
      for (const waiter of entry.waiters) waiter.reject(cancelled())
      entry.waiters.clear()
    }
    disposal = (async () => {
      const settled = await Promise.allSettled(pending.map(cancelEntry))
      offProgress()
      const retained = [...handles]
      handles.clear()
      entries.clear()
      if (retained.length) await api.files.release(retained)
      const failure = settled.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return disposal
  }
  return { acquire, dispose }
}
