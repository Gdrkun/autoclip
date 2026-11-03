const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const jsx=(type,props)=>({type,props})
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)]
function mount(){
 const hooks=[];let index=0;const commits=[],ranges=[],seeks=[]
 const react={useEffect(){},useMemo:fn=>fn(),useState:initial=>{const i=index++;if(!(i in hooks))hooks[i]=initial;return[hooks[i],value=>{hooks[i]=typeof value==='function'?value(hooks[i]):value}]},
  useRef:initial=>{const i=index++;return hooks[i]??(hooks[i]={current:initial})}}
 const exports={};const mocks={react,'react/jsx-runtime':{jsx,jsxs:jsx},'../../i18n':{t:x=>x},'../../ui':{Btn:'button'},
  '../../services/api':{default:{}},'./api':{errorText:String},'./subtitleTimelineEditing':{clockTime:x=>String(x)},'./subtitle-timeline.css':{}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio/SubtitleTimeline.tsx'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>mocks[id]||assert.fail(id)})
 const doc={duration_ms:10000,speakers:[{speaker_id:'spk_0',display_name:'A',color:'#ff91bd'}],subtitles:[{id:'a',start_ms:1000,end_ms:3000,text:'test',speaker_id:'spk_0',layer:0}]}
 const render=()=>{index=0;return nodes(exports.default({projectId:'p',document:doc,scene:{start:0,end:10},time:0,selectedId:'a',
  onSelect(){},onSeek:v=>seeks.push(v),onCommit:(...args)=>commits.push(args),onRange:v=>ranges.push(v)}))}
 const chart=()=>render().find(node=>node.type==='svg')
 chart().props.ref.current={getBoundingClientRect:()=>({left:0,width:500})}
 const pointer=(x,part='move',isCue=true)=>({clientX:x,button:0,pointerId:1,preventDefault(){},currentTarget:{setPointerCapture(){}},
  target:{dataset:{part},closest:()=>isCue?{dataset:{cueId:'a'}}:null}})
 return{render,chart,pointer,commits,ranges,seeks,doc}
}
test('dragging a caption previews without editing the document and commits once on release',()=>{
 const v=mount();v.chart().props.onPointerDown(v.pointer(160))
 v.chart().props.onPointerMove(v.pointer(200));v.chart().props.onPointerMove(v.pointer(210))
 assert.equal(v.commits.length,0);assert.equal(v.doc.subtitles[0].start_ms,1000)
 v.chart().props.onPointerUp();assert.equal(v.commits.length,1)
 assert.equal(v.commits[0][0],'a');assert.ok(v.commits[0][1]>1);assert.equal(Math.round((v.commits[0][2]-v.commits[0][1])*1000),2000)
 v.chart().props.onLostPointerCapture();assert.equal(v.commits.length,1)
})
test('edge dragging keeps a nonempty interval and pointer cancellation commits nothing',()=>{
 const v=mount();v.chart().props.onPointerDown(v.pointer(120,'start'))
 v.chart().props.onPointerMove(v.pointer(500,'start'));v.chart().props.onPointerUp()
 assert.ok(v.commits[0][1]<=2.9);assert.equal(v.commits[0][2],3)
 v.chart().props.onPointerDown(v.pointer(200));v.chart().props.onPointerMove(v.pointer(220));v.chart().props.onPointerCancel()
 assert.equal(v.commits.length,1)
})
test('background selection is separate from caption retiming; a click only seeks',()=>{
 const v=mount();v.chart().props.onPointerDown(v.pointer(190,'selection',false));v.chart().props.onPointerMove(v.pointer(260,'selection',false));v.chart().props.onPointerUp()
 assert.equal(v.commits.length,0);assert.equal(v.ranges.length,1);assert.ok(v.ranges[0].end>v.ranges[0].start)
 v.chart().props.onPointerDown(v.pointer(300,'selection',false));v.chart().props.onPointerUp()
 assert.equal(v.seeks.length,1)
})
