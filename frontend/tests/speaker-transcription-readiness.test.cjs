const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')

function nodes(value) {
  return !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
}

async function load(status, failed = false) {
  let state = null
  const effects = [], calls = []
  const exports = {}
  const jsx = (type, props) => ({ type, props })
  const mocks = {
    react: { useState: () => [state, value => { state = value }], useEffect: effect => effects.push(effect) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../i18n': { t: value => value }, '../../ui': { Row: 'row' },
    '../../services/api': { default: { get: url => { calls.push(url); return failed ? Promise.reject(new Error('offline')) : Promise.resolve(status) } } },
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/features/settings/SpeakerTranscription.tsx'), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: name => mocks[name] || assert.fail(name) })
  const render = provider => nodes(exports.default({ provider, enabled: true, prompt: '', onChange() {} })).find(node => node.props?.role === 'status').props.children
  assert.equal(render('sensevoice_local'), '加载中…')
  effects[0]()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(calls, ['/studio/speaker-subtitles/status'])
  return render
}

test('settings report readiness for the selected ASR and update when switching engines', async () => {
  const render = await load({ ready: true, sensevoice: false, whisper: true })
  assert.equal(render('sensevoice_local'), '本地说话人模型未就绪')
  assert.equal(render('whisper_local'), '本地模型已就绪')
})

test('SenseVoice can be ready while Whisper is missing', async () => {
  const render = await load({ ready: true, sensevoice: true, whisper: false })
  assert.equal(render('sensevoice_local'), '本地模型已就绪')
  assert.equal(render('whisper_local'), '本地说话人模型未就绪')
})

test('a failed local status probe does not claim any model is ready', async () => {
  const render = await load(null, true)
  assert.equal(render('sensevoice_local'), '本地说话人模型未就绪')
  assert.equal(render('whisper_local'), '本地说话人模型未就绪')
})
