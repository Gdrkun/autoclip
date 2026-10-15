const { test }=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const jsx=(type,props)=>({type,props})
function load(mocks={}) {
  const exports={}
  const source=fs.readFileSync(path.join(__dirname,'../src/features/studio/CharacterBackground.tsx'),'utf8')
  const modules={
    react:{useState:value=>[value,()=>{}],useEffect(){},useRef:current=>({current})},
    'react/jsx-runtime':{jsx,jsxs:jsx},'../../i18n':{t:(value,args)=>value.replace('{{count}}',String(args?.count))},
    '../../ui':{Btn:'button'},'../../services/api':{default:{post:()=>assert.fail('no unexpected network')}},
    './character-background.css':{},'./CreatorLibrary':{default:'creator-library'},...mocks,
  }
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports,AbortController,require:name=>modules[name]||assert.fail(name)})
  return exports
}
const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)]
test('lookup sends only character names and refresh intent, keeping transcripts out of the request',async()=>{
  const calls=[],changed=[]
  const Component=load({'../../services/api':{default:{post:async(...args)=>{calls.push(args);return {sources:[],status:'unavailable'}}}}}).default
  const tree=nodes(Component({query:'思诺snow、心宜不是心仪',onChange:value=>changed.push(value),disabled:false}))
  tree.find(node=>node.type==='input').props.onChange({target:{value:'角色新名称'}})
  assert.deepEqual(changed,['角色新名称'])
  await tree.find(node=>node.type==='button').props.onClick()
  await Promise.resolve()
  assert.equal(calls[0][0],'/studio/background-research')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])),{query:'思诺snow、心宜不是心仪',force_refresh:false})
  assert.equal(calls[0][2].signal.aborted,false)
})
test('summary presents real source links and explicitly distinguishes failed and stale lookups',()=>{
  const Summary=load().BackgroundResearchSummary
  const base={query:'角色',sources:[],status:'unavailable',cached:false,stale:false,missing_subjects:['角色']}
  const failed=nodes(Summary({report:base}))
  assert.equal(failed.find(node=>node.type==='summary').props.children[0],'暂未找到可靠的角色资料')
  const found=nodes(Summary({report:{...base,status:'partial',cached:true,stale:true,sources:[{subject:'角色',title:'公开百科',url:'https://zh.moegirl.org.cn/test',excerpt:'可核对的内容',kind:'article'}]}}))
  const link=found.find(node=>node.type==='a')
  assert.equal(link.props.href,'https://zh.moegirl.org.cn/test')
  assert.equal(link.props.rel,'noopener noreferrer')
  assert.ok(found.some(node=>node.props?.children==='更新暂时失败，使用上次保存的资料。'))
})
test('empty and busy query controls avoid accidental lookups',()=>{
  const Component=load().default
  assert.equal(nodes(Component({query:'',onChange(){},disabled:false})).find(node=>node.type==='button').props.disabled,true)
  assert.equal(nodes(Component({query:'角色',onChange(){},disabled:true})).find(node=>node.type==='input').props.disabled,true)
})
