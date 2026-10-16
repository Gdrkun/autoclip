const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const jsx=(type,props)=>({type,props})
const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)]
function load(name,mocks={}){
 const exports={};const source=fs.readFileSync(path.join(__dirname,'../src/features/studio',name),'utf8')
 const modules={'react/jsx-runtime':{jsx,jsxs:jsx},'../../i18n':{t:x=>x},'../../ui':{Btn:'button',fmtDuration:String},'../../services/api':{default:{}},'./api':{errorText:String},'./visual-reactions.css':{},...mocks}
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>modules[name]||assert.fail(name)})
 return exports
}
const logic=load('reactionEvidenceLogic.ts')
test('reaction evidence is scoped to each draft and sampled frames only',()=>{
 const events=[{id:'a',start:1,end:4,window_id:0,observed_at:[1,3,99]},{id:'b',start:8,end:10}]
 assert.deepEqual(Array.from(logic.visibleReactions(events,[{start:2,end:5}]),e=>e.id),['a'])
 assert.deepEqual(Array.from(logic.visibleReactions(events,[{start:7,end:12}]),e=>e.id),['b'])
 assert.deepEqual(Array.from(logic.evidenceFrameIndices(events[0],{windows:[{id:0,times:[1,2,3]}]})),[0,2])
})
test('reaction switch requires configured model and current consent',()=>{
 const choices=[]
 for(const allowed of [null,false,true]){
  const Component=load('ReactionOptions.tsx',{react:{useState:()=>[allowed,()=>{}],useEffect(){}}}).default
  const tree=nodes(Component({value:{},onChange:value=>choices.push(value)}))
  const checkbox=tree.find(node=>node.type==='input')
  assert.equal(checkbox.props.checked,false)
  assert.equal(checkbox.props.disabled,allowed!==true)
  if(allowed===true)checkbox.props.onChange({target:{checked:true}})
 }
 assert.equal(choices.length,1);assert.equal(choices[0].visual_reactions,true)
})
test('evidence navigation clamps start inside current scene and review carries run id',async()=>{
 const report={status:'completed',run_id:'fixture',error:'',events:[{id:'event',label:'动作',start:1,end:5,window_id:0,observed_at:[1,4],evidence:'变化',uncertainty:'不确定',ignored:false}],windows:[{id:0,times:[1,4]}]}
 const calls=[],seeks=[];let index=0
 const Component=load('ReactionEvidence.tsx',{
  react:{useState:()=>[[report,()=>{}],['',()=>{}],['',()=>{}]][index++],useEffect(){}},
  './reactionEvidenceLogic':logic,'../../services/api':{default:{defaults:{baseURL:'/api/v1'},patch:async(url,body)=>{calls.push({url,body});return report}}},
 }).default
 const tree=nodes(Component({projectId:'p',scenes:[{start:3,end:7}],onSeek:(...args)=>seeks.push(args)}))
 assert.equal(tree.filter(node=>node.type==='img').length,2)
 tree.find(node=>node.type==='button'&&node.props.children==='查看原片').props.onClick()
 assert.deepEqual(seeks,[[3,0]])
 await tree.find(node=>node.type==='button'&&node.props.children==='忽略这条依据').props.onClick()
 assert.equal(calls[0].body.run_id,'fixture');assert.equal(calls[0].body.ignored,true)
})
