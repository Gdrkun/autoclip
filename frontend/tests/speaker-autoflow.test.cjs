const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const flush=()=>new Promise(resolve=>setImmediate(resolve))
const doc={speakers:[{speaker_id:'spk_0',color:'#FF91BD'}],subtitles:[]}
function mount(get){
 const hooks=[],pending=[],intervals=new Map(),posts=[],applied=[];let index=0
 const react={useRef(value){const i=index++;return hooks[i]??(hooks[i]={current:value})},useState(value){index++;return [value,()=>{}]},
  useEffect(effect,deps){const i=index++,old=hooks[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){old?.cleanup?.();hooks[i]={deps};pending.push(()=>{hooks[i].cleanup=effect()})}}}
 const exports={},jsx=(type,props)=>({type,props})
 const mocks={react,'react/jsx-runtime':{jsx,jsxs:jsx},'../../i18n':{t:x=>x},'../../ui':{Btn:'button'},
  '../../services/api':{default:{get,post:async url=>{posts.push(url);return {status:'queued'}},defaults:{baseURL:'/api/v1'}}},
  './api':{errorText:String},'./speakerSubtitleEditing':{speakerCuesForScenes:cues=>cues},'./speaker-subtitles.css':{},'./CorrectionSuggestions':{default:'corrections'}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio/SpeakerSubtitles.tsx'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>mocks[id]||assert.fail(id),
  window:{setInterval:fn=>{const id=intervals.size+1;intervals.set(id,fn);return id},clearInterval:id=>intervals.delete(id)}})
 const render=(extra={})=>{index=0;exports.default({projectId:'p',draftId:'a',enabled:true,autoEnabled:true,dirty:false,currentTime:0,
  onApply:value=>applied.push(value),onChange(){},onLayout(){},onEnabled(){},onSeek(){},...extra});pending.splice(0).forEach(fn=>fn())}
 const unmount=()=>hooks.forEach(hook=>hook?.cleanup?.())
 return {render,posts,applied,tick:()=>Array.from(intervals.values()).forEach(fn=>fn()),unmount}
}
test('old editor queues missing voices once, then applies available results automatically',async()=>{
 let state={job:{status:'idle'},document:null};const view=mount(async()=>state)
 view.render();await flush();assert.deepEqual(view.posts,['/studio/p/speaker-subtitles/ensure'])
 view.tick();await flush();assert.equal(view.posts.length,1)
 state={job:{status:'completed'},document:doc};view.tick();await flush()
 assert.equal(view.applied.length,1);assert.equal(view.applied[0].speakers[0].speaker_id,'spk_0')
 view.tick();await flush();assert.equal(view.applied.length,1);view.unmount()
})
test('paused jobs and disabled captions never start automatic recognition',async()=>{
 for(const props of [{},{enabled:false},{autoEnabled:false}]){
  const view=mount(async()=>({job:{status:props.enabled===false||props.autoEnabled===false?'idle':'cancelled'},document:null}))
  view.render(props);await flush();view.tick();await flush();assert.equal(view.posts.length,0);view.unmount()
 }
})
test('closing captions before completion prevents automatic apply from reopening them',async()=>{
 let state={job:{status:'running'},document:null};const view=mount(async()=>state)
 view.render();await flush();view.render({autoEnabled:false})
 state={job:{status:'completed'},document:doc};view.tick();await flush()
 assert.equal(view.applied.length,0);view.unmount()
 const editor=fs.readFileSync(path.join(__dirname,'../src/features/studio/StudioEditor.tsx'),'utf8')
 assert.match(editor,/subtitles_auto_suppressed === undefined && draft.origin.startsWith/)
})
test('a late response after switching drafts cannot apply the previous document',async()=>{
 let finish;const view=mount(()=>new Promise(resolve=>{finish=resolve}))
 view.render();view.unmount();finish({job:{status:'completed'},document:doc});await flush()
 assert.equal(view.applied.length,0);assert.equal(view.posts.length,0)
})
test('an existing valid document remains reusable after a failed rerun',async()=>{
 const view=mount(async()=>({job:{status:'failed'},document:doc}))
 view.render();await flush();assert.equal(view.posts.length,0);assert.equal(view.applied.length,1);view.unmount()
})
