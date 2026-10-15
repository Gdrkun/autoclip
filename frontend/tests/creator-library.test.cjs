const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const jsx=(type,props)=>({type,props})
const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)]
function load(name,mocks={}){
 const exports={};const source=fs.readFileSync(path.join(__dirname,'../src/features/studio',name),'utf8')
 const modules={'react/jsx-runtime':{jsx,jsxs:jsx},react:{useState:v=>[v,()=>{}],useEffect(){}},'../../i18n':{t:x=>x},'../../ui':{Btn:'button',Dialog:'dialog',fmtDuration:x=>String(x)},'../../services/api':{default:{}},'./api':{errorText:e=>e.message},'./CreatorLibrary':{feedbackLabels:{humor:'搞笑'}},'./creator-library.css':{},...mocks}
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,Map,Set,crypto:{randomUUID:()=> 'new-profile'},require:name=>modules[name]||assert.fail(name)})
 return exports
}
test('vocabulary confirmation preserves timing, speakers and simultaneous captions and rejects stale text',()=>{
 const apply=load('CorrectionSuggestions.tsx').applyCorrections
 const document={speakers:[{id:'a'}],subtitles:[{id:'1',start_ms:0,end_ms:1000,text:'心仪',speaker_id:'a'},{id:'2',start_ms:0,end_ms:1000,text:'已手动修改',speaker_id:'b'}]}
 const result=apply(document,[{id:'1',before:'心仪',after:'心宜',selected:true},{id:'2',before:'旧文字',after:'新文字',selected:true}])
 assert.equal(result.subtitles[0].text,'心宜');assert.equal(result.subtitles[1].text,'已手动修改')
 assert.equal(result.subtitles[0].start_ms,0);assert.equal(result.subtitles[0].speaker_id,'a');assert.equal(document.subtitles[0].text,'心仪')
})
test('library entry is local and closed until explicitly opened',()=>{
 const Component=load('CreatorLibrary.tsx').default
 const tree=nodes(Component({query:'思诺snow'}))
 assert.equal(tree.find(item=>item.type==='dialog').props.open,false)
 assert.equal(tree.find(item=>item.type==='button').props.children,'角色档案与词库')
})
