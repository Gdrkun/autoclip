const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio/subtitleRepairEditing.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api})
const cue=(id,start,end,reason='unassigned')=>({id,start_ms:start,end_ms:end,text:id,speaker_id:'spk_0',layer:0,assignment_reason:reason})
const fixture=()=>({duration_ms:60000,speakers:[{speaker_id:'spk_0'},{speaker_id:'spk_1'}],subtitles:[cue('outside',0,2000),cue('inside',10000,13000),cue('after',40000,45000)]})
const job=()=>({status:'completed',job_id:'a'.repeat(32),start_ms:10000,end_ms:15000,subtitles:[{...cue('new',10200,14000),speaker_id:null}]})
test('replacement only changes confirmed captions in the requested source interval',()=>{
 const doc=fixture(),task=job(),signature=api.repairSignature(doc,task.start_ms,task.end_ms)
 const result=api.applyRepair(doc,task,signature,task.subtitles,'replace',false)
 assert.equal(result.length,3);assert.ok(result.includes(doc.subtitles[0])&&result.includes(doc.subtitles[2]))
 assert.equal(result[1].id,'new');assert.equal(result[1].assignment_reason,'manual');assert.equal(doc.subtitles[1].id,'inside')
})
test('manual and crossing captions are protected until explicit permission or a wider selection',()=>{
 const doc=fixture(),task=job();doc.subtitles[1].assignment_reason='manual'
 const signature=api.repairSignature(doc,10000,15000)
 assert.equal(api.applyRepair(doc,task,signature,task.subtitles,'replace',false),null)
 assert.ok(api.applyRepair(doc,task,signature,task.subtitles,'replace',true))
 doc.subtitles[1].start_ms=9000
 assert.equal(api.applyRepair(doc,task,api.repairSignature(doc,10000,15000),task.subtitles,'replace',true),null)
 assert.equal(api.applyRepair(doc,task,api.repairSignature(doc,10000,15000),task.subtitles,'append',false).length,4)
})
test('edits during inference invalidate candidates while unrelated edits remain usable',()=>{
 const doc=fixture(),task=job(),signature=api.repairSignature(doc,10000,15000)
 doc.subtitles[0].text='选区外修订';assert.ok(api.applyRepair(doc,task,signature,task.subtitles,'replace',false))
 doc.subtitles[1].text='已校对';assert.equal(api.applyRepair(doc,task,signature,task.subtitles,'replace',true),null)
})
test('invalid timing, duplicate candidate IDs and nonexistent speakers cannot be applied',()=>{
 const doc=fixture(),task=job(),signature=api.repairSignature(doc,10000,15000)
 for(const patch of [{end_ms:16000},{start_ms:NaN},{speaker_id:'spk_9'},{text:''},{layer:2}]) assert.equal(api.applyRepair(doc,task,signature,[{...task.subtitles[0],...patch}],'replace',true),null)
 assert.equal(api.applyRepair(doc,task,signature,[task.subtitles[0],task.subtitles[0]],'replace',true),null)
})
test('speaker identity is reused only from an unambiguous original interval',()=>{
 const doc=fixture(),task=job();assert.equal(api.repairCandidates(doc,task)[0].speaker_id,'spk_0')
 doc.subtitles.push({...cue('overlap',11000,13000),speaker_id:'spk_1',layer:1})
 assert.equal(api.repairCandidates(doc,task)[0].speaker_id,null)
})
