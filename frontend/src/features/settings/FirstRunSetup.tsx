import { trackExperience } from '../../analytics/experience'
import { telemetryId } from '../../analytics/workflow'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { t } from '../../i18n'
import { Btn, Dialog, StatusDot } from '../../ui'
import { useModelSettings } from './useModelSettings'
import { AIServiceFields } from './AIModelSettings'
import { connectionReady, mainConnection, needsSetup } from './modelSettingsLogic'

/**
 * First-run choice stays on the page; the setup dialog opens only on an explicit action.
 * The sample uses the same entry as the home empty state and needs no AI connection.
 */
export default function FirstRunSetup({ onStatus, openRequest = 0, onExample, exampleBusy=false }: { onStatus?: (needed: boolean) => void; openRequest?: number;onExample?:()=>void;exampleBusy?:boolean }) {
  useTranslation()
  const navigate = useNavigate()
  const m = useModelSettings('home_setup')
  const { settings } = m
  const [open, setOpen] = useState(false)
  // Decide once from the loaded document: typing a key must not close the dialog mid-edit.
  const initial = useRef<boolean | null>(null)
  if (settings && initial.current === null) initial.current = needsSetup(settings)
  const needed = !!settings && !!initial.current && !settings.saved
  useEffect(() => { if (settings) onStatus?.(needed) }, [settings, needed])
  useEffect(() => {
    if (!needed) { setOpen(false); return }
  }, [needed])
  useEffect(() => { if (openRequest > 0 && needed) setOpen(true) }, [openRequest])
  const presentation = useRef('')
  const showing = open && needed && !!settings
  useEffect(() => {
    if (!showing) { presentation.current = ''; return }
    if (!presentation.current) {
      presentation.current = telemetryId()
      trackExperience('setup_presented', { placement: 'home_setup', presentation_id: presentation.current, trigger: openRequest > 0 ? 'import_blocked' : 'initial' })
    }
  }, [showing, openRequest])
  const action = (value: 'later' | 'open_settings') => trackExperience('setup_action', { placement: 'home_setup', presentation_id: presentation.current, action: value })
  if (!settings || !needed) return null

  const later = () => { action('later');setOpen(false) }
  const main = mainConnection(settings)
  const model = settings.analysis?.model
  const fetching = !!main && !!m.busy[main.id] && !model
  const status = fetching ? t('正在获取可用模型…')
    : model ? t('已选好模型：{{model}}', { model })
    : !main ? t('先选择一家 AI 服务')
    : connectionReady(main) ? t('请确认 API Key，或直接输入模型名')
    : t('等待 API Key')
  return <><div className="studio-onboarding"><div><strong>{t('先看看出片效果，再开始制作')}</strong><p className="studio-muted">{t('示例项目无需 API Key；制作自己的素材时再连接 AI 服务。')}</p></div><div className="studio-actions">{onExample&&<Btn loading={exampleBusy} onClick={onExample}>{t('先体验示例')}</Btn>}<Btn variant="cta" onClick={()=>setOpen(true)}>{t('连接服务开始制作')}</Btn></div></div><Dialog open={open} onClose={later} title={t('先连接一个 AI 服务')}
    description={t('选一家服务、填好 API Key 就能开始，模型会自动选好。之后随时可以在设置里调整。')}
    footer={<div className="ac-setup-foot">
      <Btn variant="text" size="sm" onClick={() => { action('open_settings'); setOpen(false); navigate('/settings?section=ai', { state: { settingsEntry: 'home_setup' } }) }}>{t('更多选项')}</Btn>
      <Btn size="sm" onClick={later}>{t('稍后再说')}</Btn>
      <Btn variant="cta" size="sm" loading={m.saving} disabled={fetching} onClick={() => void m.save()}>{t('连接并保存')}</Btn>
    </div>}>
    {/* AntD popups default to z-index 1050 and would sit behind the dialog backdrop (1200). */}
    <ConfigProvider theme={{ token: { zIndexPopupBase: 1300 } }}>
      <div className="ac-setup-dialog ac-ai-settings">
        <div className="ac-rows"><AIServiceFields m={m} placement="home_setup" showVisual={false} /></div>
        {m.error && <p className="studio-error" role="alert">{m.error}</p>}
        <div className="ac-setup-status"><StatusDot tone={fetching ? 'accent' : model ? 'ok' : 'muted'} label={status} /></div>
      </div>
    </ConfigProvider>
  </Dialog></>
}
