const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
function load(name,mocks={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio',name),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>mocks[id]||assert.fail(id),crypto:{randomUUID:()=> 'added'}});return exports}
const editing=load('speakerSubtitleEditing.ts')
const cue=(id,start,end)=>({id,start_ms:start,end_ms:end,text:id,layer:0,speaker_id:'spk_0'})
const doc={schema_version:1,time_base:'clip',duration_ms:10000,speakers:[{speaker_id:'spk_0',display_name:'A',color:'#ff91bd'}],turns:[],subtitles:[cue('outside',0,400),cue('a',1200,1800),cue('gap',4500,4700),cue('edge',900,1100),cue('b',6100,6800)]}
const scenes=[{start:1,end:3},{start:6,end:7}]
const ids=cues=>Array.from(cues,c=>c.id)
const jsx=(type,props)=>({type,props})
function component(document,windows,onChange){const C=load('SpeakerSubtitles.tsx',{react:{useEffect(){},useRef:current=>({current}),useState:v=>[v,()=>{}]},'react/jsx-runtime':{jsx,jsxs:jsx},'../../i18n':{t:x=>x},'../../ui':{Btn:'button'},'../../services/api':{default:{defaults:{baseURL:'/api/v1'}}},'./api':{errorText:String},'./speakerSubtitleEditing':editing,'./speaker-subtitles.css':{},'./CorrectionSuggestions':{default:'corrections'}}).default;return C({projectId:'p',draftId:'d',document,scenes:windows,enabled:true,dirty:true,currentTime:2.9,onChange,onApply(){},onLayout(){},onEnabled(){},onSeek(){}})}
function nodes(n){return !n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)]}

test('two clip editors show only intersecting cues from a shared source transcript',()=>{
 const a=nodes(component(doc,[scenes[0]],()=>{})),b=nodes(component(doc,[scenes[1]],()=>{}))
 assert.deepEqual(a.filter(n=>n.type==='textarea').map(n=>n.props.value),['a','edge'])
 assert.deepEqual(b.filter(n=>n.type==='textarea').map(n=>n.props.value),['b'])
 let changed
 const tree=nodes(component(doc,[scenes[0]],value=>{changed=value}))
 tree.find(n=>n.props?.['aria-label']==='字幕文本 a').props.onChange({target:{value:'Only this draft'}})
 assert.equal(changed.subtitles.find(c=>c.id==='b').text,'b')
 assert.equal(doc.subtitles.find(c=>c.id==='a').text,'a')
})
test('scoped reorder and sorting keep hidden cues in their own positions',()=>{
 const moved=editing.moveSpeakerCueInScenes(doc.subtitles,[scenes[0]],'edge',-1)
 assert.deepEqual(ids(moved),['outside','edge','gap','a','b'])
 const sorted=editing.sortSpeakerCuesInScenes(doc.subtitles,[scenes[0]])
 assert.deepEqual(ids(sorted),['outside','edge','gap','a','b'])
 assert.equal(sorted[2],doc.subtitles[2]);assert.equal(sorted[4],doc.subtitles[4])
})
test('supplement and audition stay inside a selected scene even at cut boundaries',()=>{
 const inserted=editing.insertSpeakerCueInScenes(doc,[scenes[0]],2.9,'new','New')
 const added=inserted.find(c=>c.id==='new')
 assert.equal(added.start_ms,2900);assert.equal(added.end_ms,3000)
 const after=editing.insertSpeakerCueInScenes(doc,[scenes[0]],2.9,'after','After','edge').find(c=>c.id==='after')
 assert.equal(after.start_ms,1100);assert.equal(after.end_ms,1200)
 assert.deepEqual(JSON.parse(JSON.stringify(editing.speakerCueSeek(doc.subtitles[3],scenes,1))),{seconds:1,sceneIndex:0})
 assert.deepEqual(JSON.parse(JSON.stringify(editing.speakerCueSeek(doc.subtitles[4],scenes,0))),{seconds:6.1,sceneIndex:1})
})
