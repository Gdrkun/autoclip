const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
function load(name, mocks = {}) {
  const exports = {}
  const source = fs.readFileSync(path.join(__dirname,'../src/features/studio',name),'utf8')
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>mocks[name]||assert.fail(name)})
  return exports
}
const logic = load('selectionPreferencePresets.ts')
test('four presets append to free text and toggle independently without losing the request', () => {
  const first=logic.selectionPreferencePresets[0].instruction, second=logic.selectionPreferencePresets[1].instruction
  const added=logic.toggleSelectionPreference('不要日常闲聊',first)
  assert.equal(added,'不要日常闲聊\n'+first)
  const both=logic.toggleSelectionPreference(added,second)
  assert.equal(logic.toggleSelectionPreference(both,first),'不要日常闲聊\n'+second)
  assert.equal(logic.selectionPreferencePresets.length,4)
  const full='x'.repeat(1000)
  assert.equal(logic.toggleSelectionPreference(full,first),full)
})
test('visible preference controls emit the complete editable request', () => {
  const jsx=(type,props)=>({type,props}), changes=[]
  const Component=load('SelectionPreferences.tsx',{'../../i18n':{t:x=>x},'./selectionPreferencePresets':logic,'./selection-preferences.css':{},'react/jsx-runtime':{jsx,jsxs:jsx}}).default
  const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)]
  const tree=nodes(Component({value:'少选闲聊',disabled:false,onChange:value=>changes.push(value)}))
  tree.find(node=>node.type==='button'&&node.props.children==='唱歌').props.onClick()
  assert.ok(changes[0].startsWith('少选闲聊\n优先保留唱歌'))
  const input=tree.find(node=>node.type==='textarea')
  input.props.onChange({target:{value:'只保留搞笑互动'}})
  assert.equal(changes[1],'只保留搞笑互动')
  assert.equal(input.props.maxLength,1000)
})
