const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const jsx=(type,props)=>({type,props})
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children),...nodes(n.props?.footer)]
function load(file,mocks={},globals={}){
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,
 {exports,require:id=>id==='react/jsx-runtime'?{jsx,jsxs:jsx}:mocks[id]||assert.fail(id),...globals});return exports
}
function state(){const data=[];let index=0;return{reset(){index=0},react:{useState(value){const key=index++;if(!(key in data))data[key]=typeof value==='function'?value():value;return[data[key],next=>{data[key]=typeof next==='function'?next(data[key]):next}]},useEffect(){},useRef:value=>({current:value})}}}
function storage(){const records=new Map();return{getItem:key=>records.get(key)||null,setItem:(key,value)=>records.set(key,value),removeItem:key=>records.delete(key)}}
const defaults={goal:'auto',language:'source',aspect:null,duration:null,instruction:'',auto_render_limit:3,portrait_style:'auto'}

test('upload progress handles unknown totals, invalid counters and completed transfers',()=>{
 const tools=load('features/studio/uploadProgress.ts')
 assert.equal(tools.uploadProgress(20).percent,null);assert.equal(tools.uploadProgress(20,100).percent,20)
 assert.equal(tools.uploadProgress(102,100).percent,100);assert.equal(tools.uploadProgress(102,100).transferred,true)
 assert.equal(tools.uploadProgress(NaN,0).bytes,0);assert.equal(tools.uploadProgress(0,0).transferred,false)
})

test('canceled imports produce a cancellation event instead of a request failure',async()=>{
 const events=[],tools=load('analytics/studio.ts',{'./posthog':{captureBusinessEvent:name=>events.push(name)},'./observer':{workflow:{generation:()=>1,active:()=>true}},'./workflow':{safeStudioProperties:value=>value,telemetryId:()=> 't-test',errorCode:()=> 'unknown'}})
 await assert.rejects(tools.observeStudioOperation('studio_import',async()=>{throw Object.assign(new Error('cancelled'),{code:'ERR_CANCELED'})}))
 assert.equal(events.join(','),'studio_import_requested,studio_import_cancelled')
})

test('project search and sorting preserve data, hide staged imports and include failed projects',()=>{
 const tools=load('features/studio/projectLibrary.ts'),projects=[{id:'a',name:'Alpha',status:'completed',created_at:'2026-01-01',updated_at:'2026-11-01'},
 {id:'b',name:'Bravo',status:'failed',created_at:'2026-02-01',updated_at:'2026-11-10'},
 {id:'c',name:'Alpha staged',status:'completed',settings:{import_staging:true},created_at:'2026-11-11'}]
 assert.equal(tools.filterProjects(projects,'  ALPHA ','all','updated').map(p=>p.id).join(','),'a')
 assert.equal(tools.filterProjects(projects,'','error','updated')[0].id,'b')
 assert.equal(tools.filterProjects(projects,'','all','updated')[0].id,'b')
 assert.equal(projects[0].id,'a');assert.equal(projects.length,3)
})

test('production with no render job is active, and backups are excluded from completion totals',()=>{
 const hooks=state(),Component=load('features/studio/TaskProgress.tsx',{react:hooks.react,'../../i18n':{t:(key,values)=>values?key.replace(/{{(\w+)}}/g,(_,k)=>values[k]):key},'../../ui':{fmtDuration:String},'../../analytics/workflow':{utcMillis:()=>0}}).default
 const workspace={analysis:null,jobs:[],generation:{status:'production'},output_variants:[{status:'completed'},{status:'on_demand'}]}
 const tree=nodes(Component({workspace}))
 assert.ok(tree.some(n=>n.props?.role==='status'&&n.props.children==='任务在后台继续，可离开本页处理其他项目。'))
 assert.ok(tree.some(n=>Array.isArray(n.props?.children)&&n.props.children.join('').includes('已完成 1 / 1 个版本')))
})

test('presets persist only preferences and platforms and update explicit matching names',()=>{
 const localStorage=storage(),draftTools=load('features/studio/importDraft.ts',{'./types':{defaultImportOptions:defaults}},{sessionStorage:storage()})
 const tools=load('features/studio/productionPresetStorage.ts',{'./importDraft':draftTools},{localStorage})
 let items=tools.storeProductionPreset([],{id:'p',name:'搞笑切片',options:{...defaults,instruction:'保留铺垫',quick_preview:true},platforms:['bilibili'],file:'must not persist',url:'must not persist'})
 const restored=tools.readProductionPresets();assert.equal(restored[0].options.instruction,'保留铺垫');assert.equal(restored[0].platforms[0],'bilibili')
 assert.equal(restored[0].file,undefined);assert.doesNotMatch(localStorage.getItem('autoclip.productionPresets.v1'),/must not persist/)
 items=tools.storeProductionPreset(items,{...items[0],id:'p2',options:{...defaults,quick_preview:false}});assert.equal(items.length,1)
 assert.equal(tools.removeProductionPreset(items,'p2').length,0)
})

test('broken or denied display storage leaves the comfortable setting usable',()=>{
 const document={documentElement:{dataset:{}}},localStorage={getItem(){throw new Error('denied')},setItem(){throw new Error('denied')}}
 const tools=load('features/settings/displayDensity.ts',{}, {document,localStorage})
 assert.equal(tools.readDisplayDensity(),'comfortable');tools.applyDisplayDensity('compact');assert.equal(document.documentElement.dataset.density,'compact')
})

test('batch downloads deduplicate files, retain failed items and stop between files',async()=>{
 const tools=load('features/studio/batchDownloads.ts'),saved=[],progress=[]
 const result=await tools.runDownloadBatch(['a','a','b','c'],async id=>{if(id==='b')throw new Error('disk');saved.push(id)},{stop:()=>false,progress:(done,total)=>progress.push([done,total])})
 assert.equal(saved.join(','),'a,c');assert.equal(result.failed.join(','),'b');assert.equal(progress.length,3)
 let stop=false;const partial=await tools.runDownloadBatch(['a','b'],async()=>{stop=true},{stop:()=>stop,progress(){}})
 assert.equal(partial.saved.join(','),'a');assert.equal(partial.remaining.join(','),'b')
})

test('player controls clamp jumps and apply speed changes without stealing text or range editing',()=>{
 const calls=[],Component=load('features/studio/PlayerBar.tsx',{'../../i18n':{t:x=>x},'../../ui':{fmtDuration:String}}).default
 const tree=nodes(Component({offset:1,length:5,playing:false,muted:false,onToggle:()=>calls.push('toggle'),onSeek:value=>calls.push(value),onMute(){},rate:1,onRate:value=>calls.push(value)}))
 tree.find(n=>n.props?.children==='后退 2 秒').props.onClick();assert.equal(calls[0],0)
 tree.find(n=>n.props?.['aria-label']==='播放速度').props.onChange({target:{value:'1.5'}});assert.equal(calls[1],1.5)
 const group=tree.find(n=>n.props?.['aria-label']==='播放控制')
 const event={key:'l',target:{closest:()=>false,tagName:'DIV'},preventDefault(){},stopPropagation(){}}
 group.props.onKeyDown(event);assert.equal(calls[2],3)
 group.props.onKeyDown({...event,target:{closest:()=>true}});assert.equal(calls.length,3)
})

test('first-run UI offers a free sample while keeping connection fields behind an explicit action',()=>{
 const hooks=state(),calls=[],Component=load('features/settings/FirstRunSetup.tsx',{react:hooks.react,'react-i18next':{useTranslation(){}},'react-router-dom':{useNavigate:()=>()=>{}},antd:{ConfigProvider:'config'},
 '../../analytics/experience':{trackExperience(){}},'../../analytics/workflow':{telemetryId:()=>''},'../../i18n':{t:x=>x},'../../ui':{Btn:'button',Dialog:'dialog',StatusDot:'status'},
 './useModelSettings':{useModelSettings:()=>({settings:{saved:false,connections:[],analysis:null},busy:{},save(){}})},'./AIModelSettings':{AIServiceFields:'fields'},
 './modelSettingsLogic':{needsSetup:()=>true,connectionReady:()=>false,mainConnection:()=>null},
 }).default
 const render=()=>{hooks.reset();return nodes(Component({onExample:()=>calls.push('sample')}))}
 assert.equal(render().find(n=>n.type==='dialog').props.open,false)
 render().find(n=>n.props?.children==='先体验示例').props.onClick();assert.equal(calls[0],'sample')
 render().find(n=>n.props?.children==='连接服务开始制作').props.onClick();assert.equal(render().find(n=>n.type==='dialog').props.open,true)
})

test('export history groups drafts and distinguishes old immutable files from current draft versions',()=>{
 const hooks=state(),Component=load('features/studio/ExportHistory.tsx',{react:hooks.react,'react-i18next':{useTranslation:()=>({t:x=>x})},'../../i18n':{getLocale:()=> 'zh-CN'},
 './StudioDownloadLink':{default:'download'},'./BatchExportDownload':{default:'batch'},'react-router-dom':{Link:'link'},'../../ui':{Dialog:'dialog',ProgressLine:'progress'},
 }).default
 const jobs=[{job_id:'old',draft_id:'d',title:'旧成片',revision:1,status:'completed',created_at:'2026-01-01'},{job_id:'new',draft_id:'d',title:'新成片',revision:2,status:'completed',created_at:'2026-11-11'}]
 const tree=nodes(Component({projectId:'p',jobs,drafts:[{id:'d',revision:2,title:'当前稿'}],open:true,onClose(){}}))
 assert.equal(tree.filter(n=>n.type==='section').length,1)
 const rows=tree.filter(n=>n.props?.className==='studio-history-row')
 assert.match(rows[0].props.children[1].props.children.join(''),/与当前草稿版本一致/)
 assert.match(rows[1].props.children[1].props.children.join(''),/旧版成片，未包含最新草稿修改/)
})
