import { transcribeServices } from './serviceClient'
import type { FC } from 'react'
import type { TranscribeConnection } from './serviceClient'
import { api, React } from './runtime'
import { uiText } from './localization'
import { languageLabel, orderedLanguages } from './languages'
import { MODEL_OPTIONS } from './models'
import { FOLLOW_POSITIONS } from './follow'
import { onChanged, readSettings, writeSetting } from './store'

/**
 * Settings → Plugins → Transcribe.
 *
 * The Whisper row is the reason this pane earns its keep: it answers "is the
 * engine installed, and where" *before* someone presses Transcribe on a
 * two-hour recording and waits for a failure.
 */
export const SettingsView: FC = () => {
  const { Button, RangeField, ReadOnlyValue, Row, Section, SelectField, TextField, Toggle } = api.ui.settings
  const [settings, setSettings] = React.useState(() => readSettings())
  const [status, setStatus] = React.useState<{ available: boolean; binPath: string | null; ffmpeg: boolean } | null>(
    null
  )
  const [pathDraft, setPathDraft] = React.useState(settings.whisperPath)
  const [followDraft, setFollowDraft] = React.useState(() => FOLLOW_POSITIONS.indexOf(settings.followPosition))
  const [error, setError] = React.useState('')
  const [connections, setConnections] = React.useState<TranscribeConnection[]>([])

  React.useEffect(() => {
    const refresh = (): void => setSettings(readSettings())
    return onChanged(refresh)
  }, [])

  React.useEffect(() => {
    let disposed = false
    void transcribeServices(api).listConnections().then((result) => {
      if (!disposed && result.ok) {
        setConnections((result.data?.connections ?? []).filter((connection) => connection.provider === 'openai'))
      }
    })
    return () => { disposed = true }
  }, [])

  React.useEffect(() => {
    if (settings.engine !== 'local') {
      setStatus(null)
      return
    }
    let disposed = false
    void transcribeServices(api).status(settings.whisperPath).then((result) => {
      if (!disposed && result.ok && result.data) setStatus(result.data)
    })
    return () => {
      disposed = true
    }
  }, [settings.engine, settings.whisperPath])

  React.useEffect(() => {
    setFollowDraft(FOLLOW_POSITIONS.indexOf(settings.followPosition))
  }, [settings.followPosition])

  const set = (key: Parameters<typeof writeSetting>[0], value: unknown): void => {
    void writeSetting(key, value).then(() => { setSettings(readSettings()); setError('') }).catch((reason) => setError(`${uiText('transcribe.failed')} ${String(reason)}`))
  }
  const usableConnections = connections.filter((connection) => connection.configured)
  const selectedConnection = connections.find((connection) => connection.id === settings.openAiConnectionId)

  return (
    <>
      {error && <p className="transcribe-meta-error" role="alert">{error}</p>}
      <Section className="transcribe-settings" title={uiText('transcribe.settingsEngine')}>
        <Row title={uiText('transcribe.engineLabel')} description={settings.engine === 'openai' ? uiText('transcribe.engineOpenAiHelp') : uiText('transcribe.engineLocalHelp')}>
          <SelectField
            value={settings.engine}
            onChange={(value) => {
              set('engine', value)
              if (value === 'openai' && !settings.openAiConnectionId && usableConnections[0]) {
                set('openAiConnectionId', usableConnections[0].id)
              }
            }}
            options={[
              { value: 'local', label: uiText('transcribe.engineLocal') },
              { value: 'openai', label: uiText('transcribe.engineOpenAi') }
            ]}
            ariaLabel={uiText('transcribe.engineLabel')}
          />
        </Row>
        <Row title={uiText('transcribe.languageLabel')} description={uiText('transcribe.languageHelp')}>
          <SelectField
            value={settings.language}
            onChange={(value) => set('language', value)}
            options={[
              { value: '', label: uiText('transcribe.autoDetect') },
              ...orderedLanguages().map((entry) => ({ value: entry.code, label: languageLabel(entry) }))
            ]}
            ariaLabel={uiText('transcribe.languageLabel')}
          />
        </Row>
        {settings.engine === 'local' ? (
          <>
            <Row title={uiText('transcribe.modelLabel')} description={uiText('transcribe.modelHelp')}>
              <SelectField
                value={settings.model}
                onChange={(value) => set('model', value)}
                options={MODEL_OPTIONS.map((option) => ({
                  value: option.value,
                  label: api.ui.t(option.labelKey)
                }))}
                ariaLabel={uiText('transcribe.modelLabel')}
              />
            </Row>
            <Row
              title={uiText('transcribe.binPathLabel')}
              description={
                status === null
                  ? uiText('transcribe.binPathHelp')
                  : status.available
                    ? uiText('transcribe.binPathFound', { path: status.binPath ?? '' })
                    : uiText('transcribe.notInstalled')
              }
            >
              <TextField
                value={pathDraft}
                onChange={setPathDraft}
                onCommit={(value) => set('whisperPath', value.trim())}
                ariaLabel={uiText('transcribe.binPathLabel')}
                invalid={status !== null && !status.available}
              />
            </Row>
            {status && status.available && !status.ffmpeg ? (
              <Row title={uiText('transcribe.ffmpegLabel')} description={uiText('transcribe.ffmpegMissing')}>
                <span />
              </Row>
            ) : null}
          </>
        ) : (
          <>
            <Row title={uiText('transcribe.modelLabel')} description={uiText('transcribe.openAiModelHelp')}>
              <ReadOnlyValue value="whisper-1" />
            </Row>
            <Row
              title={uiText('transcribe.openAiConnectionLabel')}
              description={selectedConnection?.configured ? uiText('transcribe.openAiConnected') : uiText('transcribe.openAiNeedsConnection')}
            >
              <SelectField
                value={usableConnections.some((connection) => connection.id === settings.openAiConnectionId) ? settings.openAiConnectionId : ''}
                onChange={(value) => set('openAiConnectionId', value)}
                options={usableConnections.map((connection) => ({
                  value: connection.id,
                  label: connection.label || connection.providerName
                }))}
                placeholder={uiText('transcribe.openAiChooseConnection')}
                ariaLabel={uiText('transcribe.openAiConnectionLabel')}
              />
            </Row>
            <div className="settings-row-actions">
              <Button onClick={() => api.workspace.openSettings('ai-providers')}>
                {uiText('transcribe.manageAiProviders')}
              </Button>
            </div>
          </>
        )}
      </Section>

      <Section className="transcribe-settings" title={uiText('transcribe.settingsFollow')}>
        <Row title={uiText('transcribe.focusPositionLabel')} description={uiText('transcribe.focusPositionHelp')}>
          <div className="transcribe-slider-row">
            <RangeField
              className="transcribe-slider"
              value={followDraft}
              min={0}
              max={FOLLOW_POSITIONS.length - 1}
              step={1}
              ariaLabel={uiText('transcribe.focusPositionLabel')}
              showNumberInput={false}
              showStepMarks
              onChange={setFollowDraft}
              onCommit={(value) => set('followPosition', FOLLOW_POSITIONS[value] ?? 'middle')}
            />
            <span className="transcribe-slider-value">
              {settings.followPosition === 'top'
                ? uiText('transcribe.focusPositionTop')
                : settings.followPosition === 'upper-middle'
                  ? uiText('transcribe.focusPositionUpperMiddle')
                : settings.followPosition === 'bottom'
                  ? uiText('transcribe.focusPositionBottom')
                  : settings.followPosition === 'lower-middle'
                    ? uiText('transcribe.focusPositionLowerMiddle')
                  : uiText('transcribe.focusPositionMiddle')}
            </span>
          </div>
        </Row>
        <Row title={uiText('transcribe.followDefaultLabel')} description={uiText('transcribe.followDefaultHelp')}>
          <Toggle
            checked={settings.followByDefault}
            onChange={(value) => set('followByDefault', value)}
            label={uiText('transcribe.followDefaultLabel')}
          />
        </Row>
      </Section>
      {/* No notification section: the "Notify when finished" switch that used to
          sit here is now two rows on Preferences → Notification, where every
          event in the app is routed to Off / In-app / System / Both. Keeping a
          private copy of it would be two controls for one behaviour. */}
    </>
  )
}
