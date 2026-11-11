const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const jsx = (type, props) => ({ type, props })
const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children), ...nodes(value.props?.footer), ...nodes(value.props?.right)]
const defaults = { goal: 'auto', language: 'source', aspect: null, duration: null, instruction: '', portrait_style: 'auto', auto_render_limit: 3 }
function hooks(seed = []) {
  const values = [...seed], effects = [], timers = []
  let index = 0, first = true
  return { values, effects, timers, reset() { index = 0 }, finish() { first = false }, react: {
    useState(value) { const key = index++; if (!(key in values)) values[key] = typeof value === 'function' ? value() : value
      return [values[key], next => { values[key] = typeof next === 'function' ? next(values[key]) : next }] },
    useRef(value) { const key = index++; return values[key] ?? (values[key] = { current: value }) },
    useMemo: fn => fn(), useEffect(fn) { if (first) effects.push(fn) },
  } }
}
function load(file, mocks = {}, globals = {}) {
  const exports = {}
  const filename = path.join(__dirname, '../src', file)
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, console: { log() {}, error() {}, warn() {} }, require(id) {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (id in mocks) return mocks[id]
    if (id.endsWith('.css')) return {}
    assert.fail('Missing mock: ' + id)
  }, ...globals })
  return exports
}
const ui = { Btn: 'button', Dialog: 'dialog', Section: 'section', Row: 'row', Segmented: 'segmented', StatusDot: 'status', fmtDuration: String }
const base = { 'react-i18next': { useTranslation() {} }, '../../i18n': { t: text => text }, '../../ui': ui,
  'react-router-dom': { useNavigate: () => () => {}, useParams: () => ({ id: 'p', draftId: 'd' }) } }
function featureMocks(names) { return Object.fromEntries(names.map(name => ['./' + name, { default: name }])) }

test('returning to import restores the URL, platforms and preferences without starting a task', () => {
  const state = hooks(), restored = { source: 'link', url: 'https://example.test/video', options: { ...defaults, instruction: '保留完整笑点', quick_preview: true }, browser: 'edge', platforms: ['bilibili'], file: null, subtitle: null, fileName: '', subtitleName: '' }
  const component = load('features/studio/CreativeImport.tsx', { ...base, react: state.react, antd: { Select: 'select' },
    ...featureMocks(['PlatformPicker', 'ImportPreferences', 'SelectionPreferences', 'CreatorLibrary', 'SingingOptions', 'ReactionOptions', 'StyleProbeLine']),
    './api': { studioApi: {}, errorText: String }, '../../services/api': { speechApi: {} },
    '../../analytics/experience': { trackExperience() {} }, '../../analytics/studio': { trackQuickOutputPlatforms() {} },
    '../../analytics/flags': { useFlag: () => false }, './types': { defaultImportOptions: defaults },
    './TemplatePicker': { default: 'templates' }, './editingStyleSession': {},
    './importReadiness': { visibleIssues: () => [] },
    './importDraft': { loadImportDraft: () => restored, saveImportDraft() {}, clearImportDraft() {} },
    './uploadProgress': {},'./ProductionPresets':{default:'presets'},
  }).default
  const tree = nodes(component({ onImported: async () => {} }))
  assert.equal(tree.find(n => n.type === 'textarea').props.value, restored.url)
  assert.equal(tree.find(n => n.type === 'PlatformPicker').props.value[0], 'bilibili')
  assert.equal(tree.find(n => n.type === 'SelectionPreferences').props.value, restored.options.instruction)
})

test('returning from the editor retains the project candidate selection', () => {
  const state = hooks(), workspace = { drafts: [], jobs: [], events: [], output_variants: [{ id: 'v', status: 'on_demand' }], generation: { auto_start: true, status: 'awaiting_selection' } }
  const component = load('features/studio/StudioResults.tsx', { ...base, react: state.react,
    ...featureMocks(['SelectionFeedback', 'ExportHistory', 'DraftResultCard', 'OutputVariantCard', 'PlatformPicker','TaskProgress','BatchExportDownload']),
    './CharacterBackground': { BackgroundResearchSummary: 'background' }, './SingingOptions': { SingingSummary: 'singing' },
    './useWorkspace': { useWorkspace: () => ({ workspace, loaded: true, refresh() {} }) }, './api': { studioApi: { source: () => '' } },
    './platformLabel': { platformLabel: String }, './candidateSelection': { readCandidateSelection: () => ['v'], writeCandidateSelection() {} },
  }).default
  const tree = nodes(component({ project: { id: 'p', settings: {}, clips: [], collections: [] }, onReload() {} }))
  assert.equal(tree.find(n => n.type === 'OutputVariantCard').props.selected, true)
})

test('a failed project refresh retains existing projects and exposes a persistent retry', async () => {
  const state = hooks(), project = { id: 'p', name: 'Existing', status: 'completed', settings: {}, created_at: '2026-11-01' }
  let projects = [project], loading = false
  const store = () => ({ projects, loading, setProjects: value => { projects = value }, setLoading: value => { loading = value } })
  const component = load('pages/HomePage.tsx', { react: state.react, '../i18n': { t: text => text }, 'react-i18next': base['react-i18next'],
    'react-router-dom': base['react-router-dom'], antd: { Layout: { Content: 'content' }, Typography: { Title: 'title', Text: 'text' }, Select: { Option: 'option' }, Spin: 'spin', message: { error() {} } },
    '../components/ProjectCard': { default: 'ProjectCard' }, '../features/studio/CreativeImport': { default: 'import' }, '../features/settings/FirstRunSetup': { default: 'setup' },
    '../services/api': { projectApi: { getProjects: async () => { throw new Error('offline') } } }, '../analytics/experience': {}, '../analytics/observer': {}, '../ui': ui,
    '../stores/useSimpleProgressStore': { useSimpleProgressStore: { getState: () => ({ stopPolling() {}, clearAllProgress() {} }) } },
    '../store/useProjectStore': { useProjectStore: store }, '../hooks/useProjectPolling': { useProjectPolling() {} },
    '../features/studio/projectLibrary':{filterProjects:projects=>projects},'../features/studio/recentWork':{readRecentWork:()=>null},'../features/studio/api':{},
  }, { setTimeout: fn => { state.timers.push(fn); return 1 }, clearTimeout() {} }).default
  component(); state.finish(); state.effects.forEach(fn => fn()); state.timers.forEach(fn => fn())
  await new Promise(resolve => setImmediate(resolve))
  state.reset(); const tree = nodes(component())
  assert.equal(projects.length, 1, 'a transient failure must not clear the project list')
  assert.ok(tree.some(n => n.props?.role === 'alert'))
  assert.ok(tree.some(n => n.type === 'button' && n.props.children === '重试'))
})

function editor() {
  const doc = { id: 'd', revision: 1, title: 'Original', hook: '', origin: 'manual', aspect: 'landscape', language: 'source', subtitles: true, original_audio: true,
    scenes: [{ id: 's', start: 0, end: 10 }], speaker_subtitles: { duration_ms: 10000, speakers: [], subtitles: [] } }
  const state = hooks([doc, JSON.stringify(doc)])
  const copyTools = fs.existsSync(path.join(__dirname, '../src/features/studio/draftEditUndo.ts')) ? load('features/studio/draftEditUndo.ts') : {}
  const component = load('features/studio/StudioEditor.tsx', { ...base, react: state.react,
    ...featureMocks(['StudioDownloadLink', 'PlayerBar', 'CandidatePicker', 'TitleArtwork', 'DraftVariantDialog', 'DraftSettingsPanel', 'SpeakerSubtitles', 'SpeakerCaptionPreview', 'CaptionMaskPreview', 'KnowledgeContext', 'ReactionEvidence']),
    './api': { studioApi: { source: () => '', rewrite: async () => ({ ...doc, title: 'AI title', hook: 'AI hook' }) }, errorText: String },
    './useWorkspace': { useWorkspace: () => ({ workspace: { drafts: [doc], jobs: [] }, refresh() {} }) },
    './types': { draftDuration: () => 10, draftError: () => null, frameModeAt: () => '', cropAt: () => .5, languages: [] },
    './titlePresets': { isArtworkStyle: () => false, titlePresets: [] }, './draftExportState': { draftExportState: () => ({}) }, './draftEditUndo': copyTools,
    './recentWork':{},
  }).default
  const render = () => { state.reset(); const wrapper = component(); return nodes(wrapper.type(wrapper.props)) }
  const changeCaptions = text => render().find(n => n.type === 'SpeakerSubtitles').props.onChange({ ...doc.speaker_subtitles, subtitles: [{ id: 'a', text }] })
  const rewrite = async () => {
    render().find(n => n.props?.['aria-label'] === '文案修改要求').props.onChange({ target: { value: '短一点' } })
    await render().find(n => n.type === 'button' && n.props.children === '改一版文案').props.onClick()
  }
  const apply = () => render().find(n => n.type === 'button' && n.props.children === '应用修改').props.onClick()
  return { render, rewrite, apply, changeCaptions, draft: () => state.values[0] }
}

test('applying an AI copy response preserves caption edits made after the request', async () => {
  const view = editor(); await view.rewrite(); view.changeCaptions('Latest caption'); view.apply()
  assert.equal(view.draft().title, 'AI title')
  assert.equal(view.draft().speaker_subtitles.subtitles[0]?.text, 'Latest caption')
})

test('undoing AI copy preserves later caption edits and the current revision', async () => {
  const view = editor(); await view.rewrite(); view.apply(); view.changeCaptions('Keep my correction')
  view.render().find(n => n.type === 'button' && /^撤销/.test(n.props.children)).props.onClick()
  assert.equal(view.draft().title, 'Original')
  assert.equal(view.draft().speaker_subtitles.subtitles[0]?.text, 'Keep my correction')
  assert.equal(view.draft().revision, 1)
})

test('undo leaves later manual title edits and unrelated scene changes intact', () => {
  const tools = load('features/studio/draftEditUndo.ts')
  const draft = { id: 'd', title: 'Manual title', hook: 'AI hook', scenes: [{ id: 'new' }], revision: 7 }
  const result = tools.undoDraftEdit(draft, { kind: 'copy', before: { title: 'Old', hook: '' }, after: { title: 'AI title', hook: 'AI hook' } })
  assert.equal(result.title, 'Manual title'); assert.equal(result.hook, ''); assert.equal(result.revision, 7)
  assert.equal(result.scenes, draft.scenes)
  assert.equal(tools.undoDraftEdit(draft, { kind: 'scenes', before: [], after: [{ id: 'stale' }] }), draft)
})

test('import recovery retains File objects during navigation and only stores names across refresh', () => {
  const records = new Map(), sessionStorage = { getItem: k => records.get(k) || null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) }
  const module = () => load('features/studio/importDraft.ts', { './types': { defaultImportOptions: defaults } }, { sessionStorage })
  const first = module(), file = { name: 'recording.mp4', secretBytes: 'NEVER SERIALIZE MEDIA' }
  const value = { source: 'file', url: '', options: { ...defaults, language: 'ja' }, browser: '', platforms: ['bilibili'], file, subtitle: null, fileName: file.name, subtitleName: '' }
  first.saveImportDraft(value)
  assert.equal(first.loadImportDraft().file, file)
  assert.doesNotMatch([...records.values()][0], /secretBytes|NEVER SERIALIZE MEDIA/)
  const refreshed = module().loadImportDraft()
  assert.equal(refreshed.file, null); assert.equal(refreshed.fileName, file.name); assert.equal(refreshed.options.language, 'ja')
  first.clearImportDraft(); assert.equal(first.loadImportDraft(), null); assert.equal(records.size, 0)
})

test('malformed recovery storage and unavailable storage cannot break the import form', () => {
  const records = new Map([['autoclip.importDraft.v1', '{bad']])
  const sessionStorage = { getItem: k => records.get(k), setItem: (k,v) => records.set(k,v), removeItem: k => records.delete(k) }
  const module = () => load('features/studio/importDraft.ts', { './types': { defaultImportOptions: defaults } }, { sessionStorage })
  assert.equal(module().loadImportDraft(), null)
  sessionStorage.setItem('autoclip.importDraft.v1', JSON.stringify({ version: 1, options: { goal: 'unknown', language: 'bad', duration: -1 }, platforms: [null, 'bilibili', 'bilibili', {}] }))
  const restored = module().loadImportDraft()
  assert.equal(restored.options.goal, 'auto'); assert.equal(restored.options.language, 'source'); assert.equal(restored.options.duration, null)
  assert.equal(restored.platforms.join(','), 'bilibili')
  sessionStorage.setItem = () => { throw new Error('denied') }
  const unavailable = module(); unavailable.saveImportDraft({ ...restored, url: 'https://example.test/keep' })
  assert.equal(unavailable.loadImportDraft().url, 'https://example.test/keep')
})

test('candidate selections are isolated by project, deduplicated and cleared explicitly', () => {
  const records = new Map(), sessionStorage = { getItem: k => records.get(k) || null, setItem: (k,v) => records.set(k,v), removeItem: k => records.delete(k) }
  const tools = load('features/studio/candidateSelection.ts', {}, { sessionStorage })
  tools.writeCandidateSelection('p', ['v1', 'v1', 'v2'])
  assert.equal(tools.readCandidateSelection('p').join(','), 'v1,v2'); assert.equal(tools.readCandidateSelection('other').length, 0)
  tools.writeCandidateSelection('p', []); assert.equal(tools.readCandidateSelection('p').length, 0)
  tools.rememberCandidateScroll('p', 480)
  assert.equal(tools.takeCandidateScroll('other'), null)
  assert.equal(tools.takeCandidateScroll('p'), 480); assert.equal(tools.takeCandidateScroll('p'), null)
})

test('candidate playback follows the selected scenes, skips gaps and stops at the final boundary', async () => {
  const state = hooks(), scenes = [{ id: 'a', start: 2, end: 4 }, { id: 'b', start: 8, end: 11 }]
  const Component = load('features/studio/CandidatePreview.tsx', { ...base, react: state.react, './api': { studioApi: { source: () => '/source' } },
    './PlayerBar': { default: 'PlayerBar' }, './candidatePlayback': load('features/studio/candidatePlayback.ts'),
  }).default
  const render = () => { state.reset(); return nodes(Component({ projectId: 'p', scenes })) }
  const player = { currentTime: 0, paused: true, play() { this.paused = false; return Promise.resolve() }, pause() { this.paused = true } }
  const video = () => render().find(n => n.type === 'video').props
  video().ref.current = player; video().onLoadedMetadata(); assert.equal(player.currentTime, 2)
  render().find(n => n.type === 'PlayerBar').props.onToggle(); assert.equal(player.paused, false)
  player.currentTime = 4.1; video().onTimeUpdate(); assert.equal(player.currentTime, 8)
  render().find(n => n.type === 'PlayerBar').props.onSeek(3); assert.equal(player.currentTime, 9)
  player.currentTime = 11.1; video().onTimeUpdate(); assert.equal(player.paused, true); assert.equal(player.currentTime, 11)
  render().find(n => n.type === 'PlayerBar').props.onToggle(); assert.equal(player.currentTime, 2)
})
