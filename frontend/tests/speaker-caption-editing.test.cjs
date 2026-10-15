const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
function load(name, mocks = {}) {
  const exports = {}
  const source = fs.readFileSync(path.join(__dirname, '../src/features/studio', name), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, crypto: { randomUUID: () => 'new-cue' }, require: name => mocks[name] || assert.fail(name) })
  return exports
}
const editing = load('speakerSubtitleEditing.ts')
const cue = (id, start, end, layer = 0) => ({ id, start_ms: start, end_ms: end, layer, text: id, speaker_id: null })
const doc = { schema_version: 1, time_base: 'clip', duration_ms: 7000, speakers: [], turns: [], subtitles: [cue('a', 0, 1000), cue('b', 4000, 5000)] }
const ids = cues => Array.from(cues, cue => cue.id)

test('supplement inserts by playback time and row insertion stays directly after the chosen row', () => {
  const inserted = editing.insertSpeakerCue(doc, 2, 'new', 'New')
  assert.deepEqual(ids(inserted), ['a', 'new', 'b'])
  assert.equal(inserted[1].start_ms, 2000)
  assert.equal(inserted[1].end_ms, 4000)
  const after = editing.insertSpeakerCue(doc, 6, 'after', 'After', 'a')
  assert.deepEqual(ids(after), ['a', 'after', 'b'])
  assert.equal(after[1].start_ms, 1000)
  assert.deepEqual(ids(doc.subtitles), ['a', 'b'])
})
test('row moves and sorting preserve text, identity and source timestamps', () => {
  const moved = editing.moveSpeakerCue(doc.subtitles, 1, -1)
  assert.deepEqual(ids(moved), ['b', 'a'])
  assert.equal(moved[0], doc.subtitles[1])
  assert.deepEqual(ids(editing.sortSpeakerCues(moved)), ['a', 'b'])
  assert.equal(editing.moveSpeakerCue(doc.subtitles, 0, -1), doc.subtitles)
  assert.equal(editing.insertSpeakerCue(doc, 999, 'last', 'End').at(-1).end_ms, 7000)
})
test('preview coordinates match ASS layout and overlap allocation, including round-to-even pixels', () => {
  const geometry = editing.speakerCaptionGeometry(320, 180, 'clean', { font_scale: 2, x: .3, y: .5 })
  assert.deepEqual(JSON.parse(JSON.stringify(geometry)), { fontSize: 28, x: 96, y: 90, rowGap: 45 })
  assert.equal(editing.speakerCaptionGeometry(1920, 1080, 'clean', { font_scale: .5, x: .5, y: .91 }).fontSize, 22)
  const overlap = { ...doc, subtitles: [cue('b', 100, 1500), cue('a', 100, 1200)] }
  assert.deepEqual(Array.from(editing.activeSpeakerRows(overlap, .8, 0, 2), row => [row.cue.id, row.slot]), [['b', 0], ['a', 1]])
})
test('actual editor controls change layout and reorder or insert cues without recognition calls', () => {
  const jsx = (type, props) => ({ type, props })
  const Component = load('SpeakerSubtitles.tsx', {
    react: { useEffect() {}, useRef: current => ({ current }), useState: current => [current, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx }, '../../i18n': { t: x => x }, '../../ui': { Btn: 'button' },
    '../../services/api': { default: { defaults: { baseURL: '/api/v1' }, get: () => assert.fail('no recognition') } },
    './api': { errorText: String }, './speakerSubtitleEditing': editing, './speaker-subtitles.css': {}, './CorrectionSuggestions': {default:'correction-suggestions'},
  }).default
  const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
  let next, layout
  const tree = nodes(Component({ projectId: 'p', draftId: 'd', document: doc, enabled: true, dirty: true, currentTime: 2,
    onChange: value => { next = value }, onLayout: value => { layout = value }, onEnabled() {}, onSeek() {} }))
  const named = label => tree.find(node => node.props?.['aria-label'] === label)
  named('字幕大小（%）').props.onChange({ target: { value: '150' } })
  assert.equal(layout.font_scale, 1.5)
  named('字幕描边').props.onChange({ target: { checked: false } })
  assert.equal(layout.outline_enabled, false)
  named('描边粗细（px）').props.onChange({ target: { value: '3.5' } })
  assert.equal(layout.outline_width, 3.5)
  named('描边颜色').props.onChange({ target: { value: '#12ABEF' } })
  assert.equal(layout.outline_color, '#12ABEF')
  named('上移 b').props.onClick()
  assert.deepEqual(ids(next.subtitles), ['b', 'a'])
  named('在此后补句 a').props.onClick()
  assert.deepEqual(ids(next.subtitles), ['a', 'new-cue', 'b'])
  assert.equal(named('上移 a').props.disabled, true)
})


test('outline defaults preserve legacy width and explicit widths follow the font scale', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(editing.speakerCaptionOutline())), { enabled: true, width: 2, color: '#000000' })
  const layout = { font_scale: 1.5, x: .5, y: .91, outline_width: 3, outline_color: '#12ABEF' }
  assert.equal(editing.speakerCaptionOutline(layout).width, 4.5)
  assert.equal(editing.speakerCaptionOutline({...layout, outline_enabled:false}).width, 0)
})

test('actual caption preview uses colored text strokes and supports removing them', () => {
  const jsx = (type, props) => ({ type, props })
  const Preview = load('SpeakerCaptionPreview.tsx', { 'react/jsx-runtime': { jsx, jsxs: jsx }, './speakerSubtitleEditing': editing }).default
  const props = { document: doc, colors: false, style: 'clean', width: 320, height: 180, time: .5, sceneStart: 0, sceneEnd: 7 }
  const layout = { font_scale: 1.5, x: .5, y: .91, outline_width: 3, outline_color: '#12ABEF' }
  const on = Preview({...props,layout}).props.children[0].props.style
  assert.equal(on.WebkitTextStroke, '2.8125cqw #12ABEF')
  assert.equal(on.paintOrder, 'stroke fill')
  assert.equal(on.color, '#FFFFFF')
  const off = Preview({...props,layout:{...layout,outline_enabled:false}}).props.children[0].props.style
  assert.equal(off.WebkitTextStroke, '0 transparent')
  assert.equal(off.textShadow, 'none')
})
