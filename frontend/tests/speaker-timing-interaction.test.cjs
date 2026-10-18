const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const jsx=(type,props)=>({type,props})
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)]
function load(file,mocks={}) {
 const exports={}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio',file),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,
  {exports,require:id=>mocks[id]||assert.fail(id),crypto:{randomUUID:()=> 'added'}})
 return exports
}
const editing=load('speakerSubtitleEditing.ts')
const cue=(id,start,end)=>({id,start_ms:start,end_ms:end,text:id,layer:1,speaker_id:'spk_0'})
function mount(options={}) {
 let document=options.document||{duration_ms:10000,speakers:[],turns:[],subtitles:[cue('hidden',0,500),cue('a',1200,1800),cue('b',2200,2800)]}
 const hooks=[];let index=0,pending=false,changes=0
 const react={useEffect(){},useRef:value=>{const i=index++;return hooks[i]??(hooks[i]={current:value})},
  useState:value=>{const i=index++;if(!(i in hooks))hooks[i]=value;return [hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next}]}}
 const Component=load('SpeakerSubtitles.tsx',{react,'react/jsx-runtime':{jsx,jsxs:jsx},'../../i18n':{t:x=>x},'../../ui':{Btn:'button'},
  '../../services/api':{default:{defaults:{baseURL:'/api'}}},'./api':{errorText:String},'./speakerSubtitleEditing':editing,
  './speaker-subtitles.css':{},'./CorrectionSuggestions':{default:'corrections'}}).default
 const render=()=>{index=0;return nodes(Component({projectId:'p',draftId:'d',document,scenes:[{start:1,end:3}],currentTime:1.5,
  enabled:true,dirty:true,onChange:value=>{document=value;changes++},onTimingPendingChange:value=>{pending=value},onApply(){},onLayout(){},onEnabled(){},onSeek(){},...options.props}))}
 const named=label=>render().find(n=>n.props?.['aria-label']===label)
 const input=(label,value)=>named(label).props.onChange({target:{value}})
 const leave=()=>render().find(n=>n.props?.className==='speaker-cue-time').props.onBlur({currentTarget:{contains:()=>false},relatedTarget:null})
 return {render,named,input,leave,doc:()=>document,pending:()=>pending,changes:()=>changes}
}
test('editing is the default view and switching to styling preserves pending timestamps',()=>{
 const v=mount(),button=text=>v.render().find(n=>n.props?.children===text&&n.type==='button')
 assert.equal(button('字幕编辑').props['aria-pressed'],true)
 assert.equal(v.render().find(n=>n.props?.className==='speaker-section').props.hidden,true)
 v.input('终点（秒） a','')
 button('人物与样式').props.onClick()
 assert.equal(v.render().find(n=>n.props?.className==='speaker-section').props.hidden,false)
 button('字幕编辑').props.onClick()
 assert.equal(v.named('终点（秒） a').props.value,'');assert.equal(v.pending(),true)
})
test('search and speaker filtering do not change the document or misnumber and disable row controls',()=>{
 const subtitles=[cue('hidden',0,500),{...cue('a',1200,1800),text:'Alpha'},{...cue('b',2200,2800),text:'Bravo',speaker_id:null}]
 const v=mount({document:{duration_ms:10000,speakers:[],turns:[],subtitles}})
 v.input('搜索字幕文字',' BRAVO ')
 assert.equal(v.named('字幕文本 a'),undefined);assert.ok(v.named('字幕文本 b'))
 assert.equal(v.named('上移 b').props.disabled,false)
 v.named('筛选说话人').props.onChange({target:{value:'spk_0'}})
 assert.equal(v.named('字幕文本 b'),undefined);assert.equal(v.changes(),0)
 v.render().find(n=>n.props?.children==='清除筛选').props.onClick()
 assert.ok(v.named('字幕文本 a'));assert.ok(v.named('字幕文本 b'));assert.equal(v.doc().subtitles,subtitles)
})
test('a focused search result stays editable when its new text stops matching the query',()=>{
 const v=mount();v.input('搜索字幕文字','a')
 const row=v.render().find(n=>n.type==='li')
 row.props.onFocusCapture()
 v.input('字幕文本 a','different text')
 assert.ok(v.named('字幕文本 a'))
 row.props.onBlurCapture({currentTarget:{contains:()=>false},relatedTarget:null})
 assert.equal(v.named('字幕文本 a'),undefined)
 assert.equal(v.doc().subtitles.length,3)
})
test('review filtering preserves a focused repaired cue until leaving and never alters hidden cues',()=>{
 const v=mount();v.input('终点（秒） a','')
 v.render().find(n=>n.props?.['aria-pressed']===false&&Array.isArray(n.props.children)).props.onClick()
 assert.ok(v.named('字幕文本 a'));assert.equal(v.named('字幕文本 b'),undefined)
 const row=v.render().find(n=>n.type==='li');row.props.onFocusCapture()
 v.input('终点（秒） a','1.9');v.named('应用时间 a').props.onClick()
 assert.ok(v.named('字幕文本 a'))
 row.props.onBlurCapture({currentTarget:{contains:()=>false},relatedTarget:null})
 assert.equal(v.named('字幕文本 a'),undefined);assert.equal(v.doc().subtitles[0].id,'hidden')
})
test('playback timestamp tools support explicit apply and cancel, and new cues clear filters',()=>{
 const v=mount();v.named('取播放位置为终点 a').props.onClick()
 assert.equal(v.doc().subtitles[1].end_ms,1800)
 v.named('应用时间 a').props.onClick();assert.equal(v.doc().subtitles[1].end_ms,1500)
 v.named('取播放位置为起点 a').props.onClick()
 // Enter on Cancel must reach the button's click handler instead of applying the times.
 v.render().find(n=>n.props?.className==='speaker-cue-time').props.onKeyDown({key:'Enter',target:{tagName:'BUTTON'},preventDefault(){assert.fail('button activation must stay native')}})
 v.named('取消时间修改 a').props.onClick();assert.equal(v.doc().subtitles[1].start_ms,1200);assert.equal(v.pending(),false)
 v.input('搜索字幕文字','nothing matches')
 v.render().find(n=>Array.isArray(n.props?.children)&&n.props.children.includes('在播放位置补句')).props.onClick()
 assert.equal(v.named('搜索字幕文字').props.value,'');assert.ok(v.named('字幕文本 added'))
 v.input('搜索字幕文字','nothing matches')
 v.render().find(n=>n.props?.children==='定位播放位置').props.onClick()
 assert.equal(v.named('搜索字幕文字').props.value,'');assert.ok(v.named('字幕文本 a'))
})
test('clearing and replacing timestamps keeps the row and original document until the pair is applied',()=>{
 const v=mount()
 v.input('起点（秒） a','')
 assert.equal(v.doc().subtitles[1].start_ms,1200,'clearing an input must not write zero into the document')
 assert.ok(v.named('字幕文本 a'))
 v.input('起点（秒） a','2.5')
 // Moving from start to end is still one editing transaction.
 v.render().find(n=>n.props?.className==='speaker-cue-time').props.onBlur({currentTarget:{contains:()=>true},relatedTarget:{}})
 assert.equal(v.changes(),0)
 v.input('终点（秒） a','2.9');v.leave()
 assert.equal(v.doc().subtitles[1].start_ms,2500);assert.equal(v.doc().subtitles[1].end_ms,2900)
 assert.equal(v.changes(),1);assert.equal(v.pending(),false)
})
test('invalid pending values stay editable, block saving, and Escape restores the saved pair',()=>{
 const v=mount();v.input('终点（秒） a','0.7');v.leave()
 assert.equal(v.doc().subtitles[1].end_ms,1800);assert.equal(v.pending(),true)
 assert.equal(v.named('终点（秒） a').props['aria-invalid'],true)
 v.render().find(n=>n.props?.className==='speaker-cue-time').props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}})
 assert.equal(v.named('终点（秒） a').props.value,'1.8');assert.equal(v.pending(),false)
})
test('committed timestamps outside the cut keep the edited row available without exposing unrelated cues',()=>{
 const v=mount();v.input('起点（秒） a','4');v.input('终点（秒） a','5');v.leave()
 assert.ok(v.named('字幕文本 a'));assert.equal(v.named('字幕文本 hidden'),undefined)
 v.named('上移 b').props.onClick()
 assert.deepEqual(Array.from(v.doc().subtitles,c=>c.id),['hidden','b','a'])
})
test('add-after inherits the speaker and line, and undo deletion preserves later edits',()=>{
 const v=mount();v.named('在此后补句 a').props.onClick()
 const added=v.doc().subtitles.find(c=>c.id==='added')
 assert.equal(added.speaker_id,'spk_0');assert.equal(added.layer,1)
 v.named('移除 a').props.onClick();assert.equal(v.named('字幕文本 a'),undefined)
 v.input('字幕文本 b','keep this change')
 v.render().find(n=>n.props?.children==='撤销删除').props.onClick()
 assert.equal(v.doc().subtitles.find(c=>c.id==='a').text,'a')
 assert.equal(v.doc().subtitles.find(c=>c.id==='b').text,'keep this change')
 assert.equal(v.doc().subtitles[0].id,'hidden')
})
test('timestamp parser accepts precise seconds and clocks but rejects blanks, invalid ranges and overflow',()=>{
 for(const [start,end] of [['772.02','773.125'],['12:52.02','12:53.125'],['0:12:52.02','0:12:53.125'],['772,02','773,125']]){
  const result=editing.speakerCueTiming(start,end,800000)
  assert.equal(result.start_ms,772020);assert.equal(result.end_ms,773125)
 }
 for(const [start,end] of [['','2'],['1',''],['1','1'],['3','2'],['1','11'],['1:60','2:05'],['NaN','2'],['-1','2'],['1e2','200'],['1','Infinity'],['1','2.0001']])
  assert.equal(editing.speakerCueTiming(start,end,10000),null,`${start} → ${end}`)
 assert.equal(editing.speakerCueTiming('0','10',10000).end_ms,10000)
})
test('undo also restores an unfinished timestamp instead of silently discarding it',()=>{
 const v=mount();v.input('终点（秒） a','');v.named('移除 a').props.onClick()
 assert.equal(v.pending(),false)
 v.render().find(n=>n.props?.children==='撤销删除').props.onClick()
 assert.equal(v.named('终点（秒） a').props.value,'');assert.equal(v.pending(),true)
})
test('the real editor blocks save, export and new-version creation while caption timing is pending',async()=>{
 const doc={id:'d',revision:1,title:'Test',origin:'manual',aspect:'portrait',subtitles:true,original_audio:true,scenes:[{id:'s',start:1,end:3}],speaker_subtitles:{duration_ms:10000,speakers:[],subtitles:[]}}
 const hooks=[doc,JSON.stringify(doc)];let index=0,saves=0,exports=0
 const react={useEffect(){},useRef:value=>{const i=index++;return hooks[i]??(hooks[i]={current:value})},
  useState:value=>{const i=index++;if(!(i in hooks))hooks[i]=value;return [hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next}]}}
 const api={source:()=>'/fixture.mp4',save:async(_id,draft)=>{saves++;return draft},export:async()=>{exports++}}
 const mocks={react,'react/jsx-runtime':{jsx,jsxs:jsx},'react-i18next':{useTranslation(){}},'../../i18n':{t:x=>x},
  'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>({id:'p',draftId:'d'})},
  '../../ui':{Btn:'button',Dialog:'dialog',Row:'row',fmtDuration:String},'./api':{studioApi:api,errorText:String},
  './useWorkspace':{useWorkspace:()=>({workspace:{drafts:[doc],jobs:[]},refresh(){}})},
  './types':{draftDuration:()=>2,draftError:()=>null,frameModeAt:()=>'',cropAt:()=>.5,languages:[]},
  './titlePresets':{isArtworkStyle:()=>false,titlePresets:[]},'./draftExportState':{draftExportState:()=>({})},'./studio.css':{}}
 for(const name of ['StudioDownloadLink','PlayerBar','CandidatePicker','TitleArtwork','DraftVariantDialog','DraftSettingsPanel','SpeakerSubtitles','SpeakerCaptionPreview','CaptionMaskPreview','KnowledgeContext','ReactionEvidence'])mocks['./'+name]={default:name}
 const Wrapper=load('StudioEditor.tsx',mocks).default
 const render=()=>{index=0;const wrapper=Wrapper();return nodes(wrapper.type(wrapper.props))}
 const captions=render().find(n=>n.type==='SpeakerSubtitles')
 // Keep a pre-update click handler to verify the synchronous pending guard too.
 const save=render().find(n=>n.props?.children==='保存草稿').props.onClick
 captions.props.onTimingPendingChange(true)
 await save()
 assert.equal(saves,0)
 await render().find(n=>n.props?.children==='渲染预览').props.onClick()
 assert.equal(exports,0)
 render().find(n=>n.props?.children==='另存为新版本').props.onClick()
 assert.equal(render().find(n=>n.type==='DraftVariantDialog').props.open,false)
 assert.ok(render().some(n=>n.props?.children==='请先修正或取消尚未应用的字幕时间。'))
 captions.props.onTimingPendingChange(false)
 await render().find(n=>n.props?.children==='渲染预览').props.onClick()
 assert.equal(exports,1,'render proceeds again after timing is resolved')
})
