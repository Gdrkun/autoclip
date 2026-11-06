const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio/subtitleRepairEditing.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api})
const cue=(id,start,end)=>({id,start_ms:start,end_ms:end,text:'人工校正后的台词',speaker_id:'spk_0',layer:1,assignment_reason:'manual'})
const doc=()=>({duration_ms:60000,speakers:[{speaker_id:'spk_0'}],subtitles:[cue('inside',10000,14000),cue('outside',40000,44000)]})
test('forced alignment only changes approved timing while preserving IDs, text and assigned speaker',()=>{
 const original=doc(),job={operation:'align',status:'completed',start_ms:9000,end_ms:16000,subtitles:[]}
 const proposal={...original.subtitles[0],start_ms:10800,end_ms:13900}
 const result=api.applyRepair(original,job,api.repairSignature(original,9000,16000),[proposal],'replace',false)
 assert.equal(result[0].start_ms,10800);assert.equal(result[0].text,original.subtitles[0].text)
 assert.equal(result[0].id,'inside');assert.equal(result[0].speaker_id,'spk_0');assert.equal(result[0].layer,1)
 assert.equal(result[1],original.subtitles[1]);assert.equal(original.subtitles[0].start_ms,10000)
})
test('alignment cannot rewrite manual text, change speaker or apply over new corrections',()=>{
 const original=doc(),job={operation:'align',status:'completed',start_ms:9000,end_ms:16000,subtitles:[]}
 const signature=api.repairSignature(original,9000,16000)
 for(const patch of [{text:'换了台词'},{speaker_id:null},{layer:0},{id:'unknown'},{start_ms:NaN}]){
  assert.equal(api.applyRepair(original,job,signature,[{...original.subtitles[0],...patch}],'replace',true),null)
 }
 const proposal={...original.subtitles[0],start_ms:11000}
 original.subtitles[0].text='又校对了一次'
 assert.equal(api.applyRepair(original,job,signature,[proposal],'replace',true),null)
})
