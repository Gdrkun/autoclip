const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const jsx=(type,props)=>({type,props})
const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)]
test('quick preview is an explicit preference and keeps automatic production as the default',()=>{
 const exports={}
 const mocks={react:{},'react-i18next':{useTranslation(){}},'../../i18n':{t:x=>x},antd:{Select:'select'},'../../ui':{Row:'row'},'./types':{goalLabels:{auto:'自动'},languages:[]}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio/ImportPreferences.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>name==='react/jsx-runtime'?{jsx,jsxs:jsx}:mocks[name]||assert.fail(name)})
 const changes=[],value={goal:'auto',language:'source',duration:null,aspect:null}
 const tree=nodes(exports.default({value,onChange:next=>changes.push(next)}))
 const mode=tree.find(item=>item.type==='select'&&item.props['aria-label']==='处理方式')
 assert.equal(mode.props.value,'automatic');mode.props.onChange('preview');assert.equal(changes[0].quick_preview,true)
 assert.equal(changes[0].language,'source')
})
test('candidate readiness settles observation without reporting completed video delivery',()=>{
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/analytics/workflow.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Date,Math,JSON,Number,Array,Object,Map,Set,String,URL})
 const records=new Map(),events=[]
 const tracker=new exports.WorkflowTracker({getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value),removeItem:key=>records.delete(key)},()=>true,name=>{events.push(name);return true})
 tracker.watch('studio-generation','p')
 const watch=tracker.list()[0]
 tracker.observeStudio(watch,{generation:{auto_start:true,status:'awaiting_selection'},analysis:{status:'completed'},drafts:[],output_variants:[{id:'v',status:'on_demand'}]})
 assert.equal(watch.settled,true);assert.equal(events.includes('studio_generation_finished'),false)
})
