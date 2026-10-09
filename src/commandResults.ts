import type { PluginCommand, ValleyPluginApi } from '@valley/plugin-sdk'
import type { CommandSideEffect } from '@valley/plugin-sdk/commands'
const text = { type: 'string', maxLength: 1048576 }
const number = { type: 'number' }
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })
const list = (items: Record<string, unknown>): Record<string, unknown> => ({ type: 'array', items, maxItems: 10000 })
export const segmentResult = object({ id: text, file: text, fileHash: text, start: number, end: number, text, language: text, model: text, transcriptionDurationMs: { type: 'number', minimum: 0 }, createdAt: text }, ['id', 'file', 'fileHash', 'start', 'end', 'text', 'language', 'createdAt'])
export const segmentsResult = list(segmentResult)
export const jobsResult = object({ jobs: list(object({ jobId: text, relPath: text, model: text, stage: { enum: ['start', 'download', 'upload', 'request', 'decode', 'done', 'error', 'cancelled'] }, percent: { type: 'number', minimum: 0, maximum: 100 }, startedAt: number, elapsedMs: number, stageStartedAt: number, stageElapsedMs: number, estimatedStageDurationMs: number, cancelling: { type: 'boolean' } }, ['jobId', 'relPath', 'stage', 'startedAt', 'elapsedMs', 'stageStartedAt', 'stageElapsedMs'])), errors: { type: 'object', maxProperties: 10000, additionalProperties: text } })
export const cancelledResult = object({ jobId: text })
export const propertiesResult = list(object({ id: text, label: text, value: { type: ['string', 'number', 'boolean', 'null'] }, readOnly: { type: 'boolean' }, type: { enum: ['text', 'select', 'boolean'] }, options: list(object({ value: text, label: text })) }, ['id', 'label', 'value']))

export const commandRegistrar = (api: Pick<ValleyPluginApi, 'commands'>) => <I = void, O = void, E extends CommandSideEffect = 'read'>(command: PluginCommand<I, O, E> & { outputSchema: Record<string, unknown> }): (() => void) => api.commands.register(command)
export const notApplied = (code: string, message: string): Error & { code: string; outcome: 'not-applied' } => Object.assign(new Error(message), { code, outcome: 'not-applied' as const })
