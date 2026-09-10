import { transcribeServices } from './serviceClient'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, type PluginProperty, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { SlotId } from '@valley/plugin-sdk/types'
import type { TranscriptSegment } from './serviceClient'
import type { PluginLinkState } from '@valley/plugin-sdk/paths'
import { React, api } from './runtime'
import { renderMetadataSegment } from './MetadataSegment'
import { loadSegments, onChanged, readSettings, segmentsForFile, writeSetting } from './store'
import { FOLLOW_POSITIONS } from './follow'
import { MODEL_OPTIONS } from './models'
import { transcribeJobs } from './jobs'
import { uiText } from './localization'

interface TranscriptSurfaces {
  selected: Map<SlotId, TranscriptSegment>
  paths: Map<SlotId, string>
  fields: Map<string, Record<string, string | boolean>>
  listeners: Set<() => void>
}
function state(): TranscriptSurfaces { return api.runtime.getOrCreate('transcribe.surfaces', () => ({ selected: new Map(), paths: new Map(), fields: new Map(), listeners: new Set() })) }
function notify(): void { for (const listener of state().listeners) listener() }
function subscribe(listener: () => void): () => void {
  const listeners = state().listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function fields(path: string): Record<string, string | boolean> { return state().fields.get(path) ?? {} }
function setField(path: string, field: string, value: string | boolean): void { state().fields.set(path, { ...fields(path), [field]: value }); notify() }

export function useTranscriptField<T extends string | boolean>(path: string, field: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const read = React.useCallback(() => (fields(path)[field] ?? fallback) as T, [path, field, fallback])
  const value = React.useSyncExternalStore(subscribe, read, read)
  const update = React.useCallback((next: React.SetStateAction<T>) => setField(path, field, typeof next === 'function' ? (next as (previous: T) => T)(read()) : next), [path, field, read])
  return [value, update]
}
export function selectTranscript(segment: TranscriptSegment, surface: SlotId): void { state().selected.set(surface, segment); notify() }
export function useTranscriptSurface(path: string, surface: SlotId): void {
  React.useEffect(() => {
    const selected = state().selected.get(surface)
    const clearSelection = surface === 'right_sidebar' && selected && selected.file !== path
    const pathChanged = state().paths.get(surface) !== path
    if (clearSelection) state().selected.delete(surface)
    if (pathChanged) state().paths.set(surface, path)
    if (clearSelection || pathChanged) notify()
  }, [path, surface])
}

const text = { type: 'string' }
export const transcriptValuesSchema = { type: 'object', additionalProperties: false, properties: {
  model: { type: 'string', enum: MODEL_OPTIONS.map((option) => option.value) }, language: text,
  follow: { type: 'boolean' }, query: text, tab: { type: 'string', enum: ['setup', 'text'] },
  engine: { type: 'string', enum: ['local', 'openai'] }, openAiConnectionId: text, whisperPath: text, followPosition: { type: 'string', enum: [...FOLLOW_POSITIONS] }
} }
export function parseTranscriptValues(raw: unknown): Record<string, string | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected transcript properties.')
  const values = raw as Record<string, unknown>
  for (const [key, value] of Object.entries(values)) {
    if (!(key in transcriptValuesSchema.properties) || typeof value !== (key === 'follow' ? 'boolean' : 'string')) throw new Error('Unsupported transcript property.')
  }
  if (values.followPosition !== undefined && !FOLLOW_POSITIONS.includes(values.followPosition as typeof FOLLOW_POSITIONS[number])) throw new Error('Invalid transcript follow position.')
  if (values.model !== undefined && !MODEL_OPTIONS.some((option) => option.value === values.model)) throw new Error('Unknown transcription model.')
  if (values.engine !== undefined && !['local', 'openai'].includes(String(values.engine))) throw new Error('Unknown transcription engine.')
  if (values.tab !== undefined && !['setup', 'text'].includes(String(values.tab))) throw new Error('Unknown transcript tab.')
  return values as Record<string, string | boolean>
}
async function applyValues(path: string, values: Record<string, string | boolean>): Promise<void> {
  if (typeof values.openAiConnectionId === 'string' && values.openAiConnectionId) {
    const result = await transcribeServices(api).listConnections()
    if (!result.ok || !result.data?.connections.some((connection) => connection.id === values.openAiConnectionId && connection.provider === 'openai' && connection.configured)) throw new Error('The OpenAI transcription connection is unavailable.')
  }
  const previousSettings = readSettings()
  const previousFields = fields(path)
  const written: Array<keyof typeof previousSettings> = []
  try {
    for (const [key, value] of Object.entries(values)) {
      const settingKey = ['engine', 'openAiConnectionId', 'whisperPath', 'followPosition'].includes(key) || (!path && ['model', 'language'].includes(key)) ? key as keyof typeof previousSettings : !path && key === 'follow' ? 'followByDefault' : undefined
      if (settingKey) { await writeSetting(settingKey, value); written.push(settingKey) }
      else { setField(path, key, value); if (key === 'tab') setField(path, 'chosenTab', true) }
    }
  } catch (reason) {
    state().fields.set(path, previousFields); notify()
    for (const key of written.reverse()) await writeSetting(key, previousSettings[key])
    throw reason
  }
}
export async function inspectTranscriptProperties(path: string): Promise<PluginProperty[]> {
  const settings = readSettings()
  const selected = fields(path)
  const segments = path ? await segmentsForFile(path) : await loadSegments()
  return [
    { id: 'file', label: uiText('transcribe.property.file'), value: path || null, readOnly: true },
    { id: 'segments', label: uiText('transcribe.property.segments'), value: segments.length, readOnly: true },
    { id: 'engine', label: uiText('transcribe.engineLabel'), value: settings.engine, type: 'select', options: [{ value: 'local', label: uiText('transcribe.engineLocal') }, { value: 'openai', label: uiText('transcribe.engineOpenAi') }] },
    { id: 'openAiConnectionId', label: uiText('transcribe.openAiConnectionLabel'), value: settings.openAiConnectionId, type: 'text' },
    { id: 'whisperPath', label: uiText('transcribe.binPathLabel'), value: settings.whisperPath, type: 'text' },
    { id: 'followPosition', label: uiText('transcribe.focusPositionLabel'), value: settings.followPosition, type: 'select', options: FOLLOW_POSITIONS.map((value) => ({ value, label: uiText(`transcribe.focusPosition${({ top: 'Top', 'upper-middle': 'UpperMiddle', middle: 'Middle', 'lower-middle': 'LowerMiddle', bottom: 'Bottom' })[value]}`) })) },
    { id: 'model', label: uiText('transcribe.modelLabel'), value: selected.model ?? settings.model, type: 'select', options: MODEL_OPTIONS.map((option) => ({ value: option.value, label: uiText(option.labelKey) })) },
    { id: 'language', label: uiText('transcribe.languageLabel'), value: selected.language ?? settings.language, type: 'text' },
    { id: 'follow', label: uiText('transcribe.follow'), value: selected.follow ?? settings.followByDefault, type: 'boolean' },
    { id: 'query', label: uiText('transcribe.searchPlaceholder'), value: selected.query ?? '', type: 'text' },
    { id: 'tab', label: uiText('transcribe.tabsLabel'), value: selected.tab ?? (segments.length ? 'text' : 'setup'), type: 'select', options: [{ value: 'text', label: uiText('transcribe.tabText') }, { value: 'setup', label: uiText('transcribe.tabSetup') }] }
  ]
}
function pathFor(subject?: { item?: { state: PluginLinkState }; view: PluginLinkState }): string {
  const raw = subject?.item?.state.file ?? subject?.view.file
  return typeof raw === 'string' ? raw : ''
}
function Overview(): React.ReactElement {
  const [count, setCount] = React.useState(0)
  React.useEffect(() => { const refresh = () => { void loadSegments().then((segments) => setCount(segments.length)).catch(() => setCount(0)) }; refresh(); return onChanged(refresh) }, [])
  return <div className="right-panel-body props-info"><dl className="props-info-table"><div className="props-info-row"><dt className="props-info-key">{uiText('transcribe.property.segments')}</dt><dd className="props-info-value">{count}</dd></div></dl><p className="props-info-hint">{uiText('transcribe.property.select')}</p><div className="props-info-actions"><button onClick={() => api.workspace.openOwnSettings()}>{uiText('transcribe.property.settings')}</button></div></div>
}

export function registerTranscriptSurfaces(pluginApi: ValleyPluginApi): () => void {
  let disposed = false
  const surfaces = ['main_workspace', 'right_sidebar', 'footer'] as const
  const offs = surfaces.map((surface) => pluginApi.interop.extensions.provide(PLUGIN_SURFACE_V1, {
    id: `transcribe.${surface}`, surface, subscribe,
    getSnapshot: () => {
      const selected = state().selected.get(surface)
      const file = surface === 'main_workspace' ? '' : state().paths.get(surface) ?? ''
      const view: PluginLinkState = { v: 1, file, ...fields(file) }
      return { title: uiText('manifest.name'), view, ...(!selected && surface === 'footer' && file ? { item: { id: file, title: file.split('/').pop() ?? file, state: view } } : {}), ...(selected ? { item: { id: selected.id, title: selected.text.slice(0, 100), state: { ...view, file: selected.file, segmentId: selected.id, start: selected.start, ...fields(selected.file) } } } : {}) }
    },
    restore: async (raw, _instanceId, options) => {
      if (raw.v !== 1) throw new Error('Unsupported transcript bookmark.')
      const file = typeof raw.file === 'string' ? raw.file : ''
      if (file && !(await pluginApi.vault.fileInfo(file))) throw new Error('The bookmarked media file no longer exists.')
      const segment = typeof raw.segmentId === 'string' ? (await loadSegments()).find((entry) => entry.id === raw.segmentId && entry.file === file) : undefined
      if (typeof raw.segmentId === 'string' && !segment) throw new Error('The bookmarked transcript segment no longer exists. It may have been replaced by a new transcription.')
      if (!options?.background && file && surface !== 'main_workspace') pluginApi.workspace.openFile(file, segment ? { type: 'media-time', seconds: segment.start } : undefined)
      state().paths.set(surface, file)
      if (segment) state().selected.set(surface, segment)
      else state().selected.delete(surface)
      const restored = Object.fromEntries(Object.entries(raw).filter(([key]) => ['model', 'language', 'follow', 'query', 'tab'].includes(key)))
      for (const [key, value] of Object.entries(parseTranscriptValues(restored))) setField(file, key, value)
      if ('tab' in restored) setField(file, 'chosenTab', true)
      notify()
    }
  }))
  offs.push(pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'transcribe.surfaceProperties', label: 'Transcribe', labelKey: 'manifest.name', icon: 'text-align-left', pluginSurfaces: ['main_workspace'], editCommand: 'properties-edit',
    inspect: ({ subject }) => inspectTranscriptProperties(pathFor(subject)),
    render: ({ subject }) => { const file = pathFor(subject); return file ? renderMetadataSegment(file) : <Overview /> }
  }))
  offs.push(pluginApi.commands.register({
      id: 'properties-edit',
      label: 'Transcribe: Edit properties',
      labelKey: 'transcribe.property.edit',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
    schema: { type: 'object', properties: { subject: { type: 'object' }, values: transcriptValuesSchema }, required: ['subject', 'values'], additionalProperties: false },
    parse: (raw) => { const input = raw as { subject?: Parameters<typeof pathFor>[0]; values?: unknown }; if (!input?.subject) throw new Error('Expected a transcript subject.'); return { path: pathFor(input.subject), values: parseTranscriptValues(input.values) } }
  },
      run: async ({ path, values }) => {
    if (path && !(await pluginApi.vault.fileInfo(path))) throw new Error('The media file no longer exists.')
    if (path && transcribeJobs().jobs.some((job) => job.relPath === path) && Object.keys(values).some((key) => ['engine', 'model', 'language', 'openAiConnectionId', 'whisperPath'].includes(key))) throw new Error('Wait for the active transcription before changing its setup.')
    const previous = Object.fromEntries((await inspectTranscriptProperties(path)).filter((property) => property.id in values).map((property) => [property.id, property.value])) as Record<string, string | boolean>
    if ('openAiConnectionId' in values) previous.openAiConnectionId = readSettings().openAiConnectionId
    await applyValues(path, values)
    return { value: await inspectTranscriptProperties(path), revert: { label: uiText('transcribe.property.edit'), run: () => applyValues(path, previous), reapply: () => applyValues(path, values) } }
  },
      revision: ({ path }) => ({ settings: readSettings(), fields: fields(path) }),
      preview: ({ path, values }) => ({ path, values })
    }))
  offs.push(onChanged(() => {
    if (disposed) return
    if (state().selected.size === 0) { notify(); return }
    void loadSegments().then((segments) => {
      if (disposed) return
      for (const [surface, selected] of state().selected) {
        const current = segments.find((entry) => entry.id === selected.id && entry.file === selected.file)
        if (current) state().selected.set(surface, current)
        else state().selected.delete(surface)
      }
      notify()
    }).catch(() => { if (!disposed) notify() })
  }))
  return () => { disposed = true; offs.forEach((off) => off()) }
}
