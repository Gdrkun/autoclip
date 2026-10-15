import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { message } from 'antd'
import { settingsApi, type TempStorageStatus } from '../../services/api'
import { t } from '../../i18n'
import { Btn, Row } from '../../ui'

export default function TempStorageSetting() {
  const [settings, setSettings] = useState<TempStorageStatus | null>(null)
  const [directory, setDirectory] = useState('')
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const load = useCallback(async () => {
    setFailed(false)
    try {
      const result = await settingsApi.getTempStorage()
      if (mounted.current) { setSettings(result); setDirectory(result.directory) }
    } catch { if (mounted.current) setFailed(true) }
  }, [])
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false } }, [load])

  const save = async (value: string) => {
    setSaving(true)
    setError('')
    try {
      const result = await settingsApi.setTempStorage(value.trim())
      if (mounted.current) {
        setSettings(result)
        setDirectory(result.directory)
        message.success(t('临时目录已保存'))
      }
    } catch (err) {
      const code = axios.isAxiosError(err) ? err.response?.data?.detail : ''
      if (mounted.current) setError(code === 'invalid_path' ? '请输入绝对路径'
        : code === 'directory_not_writable' ? '目录无法写入，请检查路径和权限' : '保存临时目录失败')
    } finally { if (mounted.current) setSaving(false) }
  }

  return <Row stack wide label={t('临时工作目录')} hint={t('上传暂存、音频处理和渲染中间文件使用此目录。在所选目录下创建 AutoClipTemp 文件夹。')}>
    <div style={{ width: '100%', minWidth: 0 }}>
      {failed ? <div role="alert">{t('读取临时目录失败')} <Btn size="sm" onClick={() => void load()}>{t('重试')}</Btn></div> : <>
        <form onSubmit={event => { event.preventDefault(); if (settings && !saving) void save(directory) }}>
          <input className="ac-input ac-input--mono" aria-label={t('临时工作目录')} autoComplete="off" spellCheck={false}
            placeholder={settings?.default_directory} value={directory} disabled={!settings || saving}
            aria-describedby="temp-storage-help" aria-invalid={!!error}
            onChange={event => { setDirectory(event.target.value); setError('') }} />
          <p className="ac-sub" id="temp-storage-help" style={{ margin: '8px 0' }}>{t('请输入运行 AutoClip 的电脑上的绝对路径，留空使用默认目录')}</p>
          {settings && <div className="ac-sub" aria-live="polite" style={{ overflowWrap: 'anywhere', margin: '8px 0 12px' }}>
            <div>{t('当前目录：{{path}}', { path: settings.effective_directory })}</div>
            <div>{settings.available && settings.free_bytes !== null
              ? t('剩余空间：{{size}} GiB', { size: (settings.free_bytes / 2 ** 30).toFixed(1) })
              : t('目录暂不可用，请选择其他路径')}</div>
          </div>}
          {error && <p role="alert" style={{ color: 'var(--ac-error)', fontSize: 13 }}>{t(error)}</p>}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Btn type="submit" size="sm" variant="cta" loading={saving} disabled={!settings || directory.trim() === settings.directory}>{t('保存')}</Btn>
            <Btn size="sm" disabled={!settings || saving || (!settings.directory && !directory)} onClick={() => void save('')}>{t('恢复默认')}</Btn>
          </div>
        </form>
        <p className="ac-sub" style={{ margin: '12px 0 0' }}>{t('修改仅影响新操作；已有临时文件、项目和成片不会移动或删除。')}</p>
      </>}
    </div>
  </Row>
}
