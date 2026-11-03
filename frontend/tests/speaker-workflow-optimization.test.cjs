const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const flush = () => new Promise(resolve => setImmediate(resolve))
const jsx = (type, props) => ({ type, props })
const nodes = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)]
function load(name, mocks = {}, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/features/studio', name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: id => mocks[id] || assert.fail(id), AbortController, ...globals })
  return exports
}
const editing = load('speakerSubtitleEditing.ts')
const cue = (id, start, text = id) => ({ id, start_ms: start, end_ms: start + 500, text, layer: 0, speaker_id: 'spk_0' })
const document = (text = 'manual') => ({ duration_ms: 10000, speakers: [], turns: [], subtitles: [cue('a', 1000, text)] })
function mount(read, initialDocument = document()) {
  let currentDocument = initialDocument, index = 0
  const hooks = [], effects = [], timers = new Map(), applied = [], reads = [], posts = []
  const react = {
    useMemo: fn => fn(),
    useRef: value => { const i = index++; return hooks[i] ?? (hooks[i] = { current: value }) },
    useState: initial => { const i = index++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value }] },
    useEffect: (effect, deps) => {
      const i = index++, old = hooks[i]
      if (!old || deps.some((value, j) => old.deps[j] !== value)) {
        old?.cleanup?.(); hooks[i] = { deps }; effects.push(() => { hooks[i].cleanup = effect() })
      }
    },
  }
  const api = { defaults: { baseURL: '/api/v1' },
    get: async (url, options) => {
      if (url === '/studio/speaker-subtitles/status') return { defaults: { backend: 'sensevoice', prompt: 'names' } }
      reads.push(options); return read(options)
    }, post: async (url, body) => { posts.push({ url, body }); return { status: 'queued', job_id: 'new' } },
  }
  const Component = load('SpeakerSubtitles.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../i18n': { t: x => x },
    '../../ui': { Btn: 'button' }, '../../services/api': { default: api }, './api': { errorText: String },
    './speakerSubtitleEditing': editing, './speaker-subtitles.css': {}, './CorrectionSuggestions': { default: 'corrections' } },
  { window: { setInterval: fn => { const id = Math.random(); timers.set(id, fn); return id }, clearInterval: id => timers.delete(id) }, crypto: { randomUUID: () => 'new-cue' } }).default
  const render = () => {
    index = 0
    const result = nodes(Component({ projectId: 'p', draftId: 'd', document: currentDocument, scenes: [{ start: 0, end: 10 }],
      enabled: true, dirty: true, currentTime: 1.2, onApply: value => applied.push(value), onChange: value => { currentDocument = value },
      onLayout() {}, onEnabled() {}, onSeek() {} }))
    effects.splice(0).forEach(fn => fn())
    return result
  }
  const unmount = () => hooks.forEach(hook => hook?.cleanup?.())
  return { render, applied, reads, posts, timers, unmount, tick: () => [...timers.values()].forEach(fn => fn()),
    edit: value => { currentDocument = value }, document: () => currentDocument }
}

test('late old GET cannot overwrite a newly accepted recognition; only its completed job is applied', async () => {
  let finishOld, count = 0
  const view = mount(() => ++count === 1 ? new Promise(resolve => { finishOld = resolve })
    : Promise.resolve({ job: { status: 'completed', job_id: 'new' }, has_document: true, document: document('new recognition') }))
  const tree = view.render()
  tree.find(node => node.type === 'button' && node.props.children === '重新识别说话人字幕').props.onClick()
  await flush()
  finishOld({ job: { status: 'completed', job_id: 'old' }, document: document('stale') })
  await flush(); view.render(); await flush()
  assert.deepEqual(view.applied.map(value => value.subtitles[0].text), ['new recognition'])
  view.unmount()
})

test('polls are lightweight, never overlap, and stop at a terminal state', async () => {
  let finish
  const view = mount(() => new Promise(resolve => { finish = resolve }))
  view.render(); view.tick(); view.tick(); await flush()
  assert.equal(view.reads.length, 1)
  assert.equal(view.reads[0].params.include_document, false)
  finish({ job: { status: 'completed' }, has_document: true, document: null })
  await flush(); view.tick(); await flush()
  assert.equal(view.reads.length, 1); assert.equal(view.timers.size, 0)
  view.unmount()
})

test('saved transcription settings reach manual recognition without switching to Whisper', async () => {
  const view = mount(async () => ({ job: { status: 'idle' }, has_document: true, document: null }))
  view.render(); await flush()
  const tree = view.render()
  assert.equal(tree.find(node => node.props?.['aria-label'] === '转写模型').props.value, 'sensevoice')
  tree.find(node => node.type === 'button' && node.props.children === '重新识别说话人字幕').props.onClick()
  await flush()
  assert.equal(view.posts[0].body.backend, 'sensevoice'); assert.equal(view.posts[0].body.prompt, 'names')
  view.unmount()
})

test('batch offset and literal replacement preserve every hidden caption and reject invalid changes', () => {
  const rows = [cue('hidden', 0, 'same'), cue('chosen', 1000, 'same same')]
  const moved = editing.shiftSpeakerCues(rows, ['chosen'], '-0.125', 10000)
  assert.equal(moved[0], rows[0]); assert.equal(moved[1].start_ms, 875)
  assert.equal(editing.shiftSpeakerCues(rows, ['hidden'], '-1', 10000), null)
  assert.equal(editing.shiftSpeakerCues(rows, ['chosen'], '', 10000), null)
  const replaced = editing.replaceSpeakerText(rows, ['chosen'], 'same', 'fixed')
  assert.equal(replaced[0], rows[0]); assert.equal(replaced[1].text, 'fixed fixed')
  assert.equal(editing.replaceSpeakerText(rows, ['hidden'], 'same', ''), null)
  assert.equal(editing.validSpeakerLayout({ font_scale: 1, x: .5, y: .91 }), true)
  assert.equal(editing.validSpeakerLayout({ font_scale: 99, x: .5, y: .91 }), false)
})

test('caption preview reuses preparation until the document or scene changes', () => {
  const doc = document(), rows = doc.subtitles
  let enumerations = 0
  doc.subtitles = new Proxy(rows, { get(target, key) { if (key === '0') enumerations++; return Reflect.get(target, key) } })
  assert.equal(editing.activeSpeakerRows(doc, 1.2, 0, 10).length, 1)
  assert.equal(editing.activeSpeakerRows(doc, 2, 0, 10).length, 0)
  assert.equal(enumerations, 1)
  const changed = { ...doc, subtitles: [cue('a', 2000)] }
  assert.equal(editing.activeSpeakerRows(changed, 2.2, 0, 10).length, 1)
})
