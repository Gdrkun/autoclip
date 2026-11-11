const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const jsx=(type,props)=>({type,props})
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)]
function mount(){
 const doc={id:'d',revision:1,title:'Test',origin:'manual',aspect:'landscape',language:'source',subtitles:true,original_audio:true,
  speaker_colors:false,scenes:[{id:'s',start:0,end:30}],speaker_subtitles:{duration_ms:30000,speakers:[],subtitles:[]}}
 const hooks=[doc,JSON.stringify(doc)];let index=0
 const react={useMemo:fn=>fn(),useEffect(){},useRef:value=>{const i=index++;return hooks[i]??(hooks[i]={current:value})},
  useState:value=>{const i=index++;if(!(i in hooks))hooks[i]=value;return[hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next}]}}
 const mocks={react,'react/jsx-runtime':{jsx,jsxs:jsx},'react-i18next':{useTranslation(){}},'../../i18n':{t:x=>x},
  'react-router-dom':{useNavigate:()=>()=>{},useParams:()=>({id:'p',draftId:'d'})},'../../ui':{Btn:'button',Dialog:'dialog',Row:'row',fmtDuration:String},
  './api':{studioApi:{source:()=>'/fixture.mp4'},errorText:String},'./useWorkspace':{useWorkspace:()=>({workspace:{drafts:[doc],jobs:[]},refresh(){}})},
  './types':{draftDuration:()=>30,draftError:()=>null,frameModeAt:()=>'',cropAt:()=>.5,languages:[]},'./titlePresets':{isArtworkStyle:()=>false,titlePresets:[]},
  './draftExportState':{draftExportState:()=>({})},'./draftEditUndo':{},'./recentWork':{},'./studio.css':{}}
 for(const name of ['StudioDownloadLink','PlayerBar','CandidatePicker','TitleArtwork','DraftVariantDialog','DraftSettingsPanel','SpeakerSubtitles','SpeakerCaptionPreview','CaptionMaskPreview','KnowledgeContext','ReactionEvidence'])mocks['./'+name]={default:name}
 const exports={}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio/StudioEditor.tsx'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>mocks[id]||assert.fail(id)})
 const render=()=>{index=0;const wrapper=exports.default();return nodes(wrapper.type(wrapper.props))}
 const player={currentTime:0,readyState:2,paused:true,play(){this.paused=false;return Promise.resolve()},pause(){this.paused=true}}
 render().find(node=>node.type==='video').props.ref.current=player
 return{render,player}
}
test('ordinary text edits retain the disabled speaker color setting',()=>{
 const view=mount()
 view.render().find(node=>node.type==='SpeakerSubtitles').props.onChange({duration_ms:30000,speakers:[],subtitles:[]})
 assert.equal(view.render().find(node=>node.type==='SpeakerSubtitles').props.enabled,false)
})
test('turning loop off lets the current audition stop at the next end boundary',()=>{
 const view=mount(),captions=view.render().find(node=>node.type==='SpeakerSubtitles')
 captions.props.onAudition(2,4,0,true)
 captions.props.onLoopChange(false)
 view.player.currentTime=4.1;view.render().find(node=>node.type==='video').props.onTimeUpdate()
 assert.equal(view.player.paused,true);assert.equal(view.player.currentTime,4.1)
})
test('scrubbing during an audition clears the old loop range',()=>{
 const view=mount()
 view.render().find(node=>node.type==='SpeakerSubtitles').props.onAudition(2,4,0,true)
 view.render().find(node=>node.type==='PlayerBar').props.onSeek(10)
 view.render().find(node=>node.type==='video').props.onTimeUpdate()
 assert.equal(view.player.currentTime,10)
})

test('jumping to the clip end stays there, and explicit play restarts the clip',()=>{
 const view=mount()
 view.render().find(node=>node.type==='PlayerBar').props.onSeek(30)
 view.render().find(node=>node.type==='video').props.onTimeUpdate()
 assert.equal(view.player.currentTime,30)
 assert.equal(view.player.paused,true)
 view.render().find(node=>node.type==='PlayerBar').props.onToggle()
 assert.equal(view.player.currentTime,0)
 assert.equal(view.player.paused,false)
})
