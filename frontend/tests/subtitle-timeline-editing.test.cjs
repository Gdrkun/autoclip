const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const exportsObject={}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio/subtitleTimelineEditing.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:exportsObject,require:id=>assert.fail(id)})
const tools=exportsObject
const cue=(id,start,end,text,speaker='spk_0',layer=0)=>({id,start_ms:start,end_ms:end,text,speaker_id:speaker,layer})
const document={duration_ms:10000,speakers:[{speaker_id:'spk_0'},{speaker_id:'spk_1'}],subtitles:[cue('hidden',0,300,'outside'),cue('mixed',1200,4000,'你还去吗？我先过去。')]}

test('split uses actual text caret and playhead; hidden cues and original document survive',()=>{
 const output=tools.splitSubtitle(document.subtitles,'mixed',5,2300,'new',null)
 assert.equal(output.length,3);assert.equal(output[0],document.subtitles[0])
 assert.equal(output[1].text,'你还去吗？');assert.equal(output[1].end_ms,2300)
 assert.equal(output[2].text,'我先过去。');assert.equal(output[2].start_ms,2300);assert.equal(output[2].speaker_id,null)
 assert.equal(document.subtitles[1].end_ms,4000)
 for(const [caret,time] of [[0,2300],[99,2300],[5,1200],[5,4000],[5,NaN]])assert.equal(tools.splitSubtitle(document.subtitles,'mixed',caret,time,'new'),null)
})

test('merge is limited to the same speaker and display row; combined length stays bounded',()=>{
 const rows=[cue('a',1200,2000,'你好'),cue('b',2000,3000,'再见')]
 assert.equal(tools.mergeSubtitles(rows,'a','b')[0].text,'你好 再见')
 assert.equal(tools.mergeSubtitles(rows,'a','b')[0].end_ms,3000)
 assert.equal(tools.mergeSubtitles([rows[0],{...rows[1],speaker_id:'spk_1'}],'a','b'),null)
 assert.equal(tools.mergeSubtitles([rows[0],{...rows[1],layer:1}],'a','b'),null)
 assert.equal(tools.mergeSubtitles([{...rows[0],text:'a'.repeat(2000)},rows[1]],'a','b'),null)
})

test('adding overlapping speech preserves both independent timing ranges and speaker identities',()=>{
 const rows=tools.addSubtitleRange(document,{start:1,end:5},1800,3500,'overlap','我也说一句','spk_1',1)
 assert.equal(rows.length,3)
 assert.equal(rows.find(c=>c.id==='mixed').end_ms,4000)
 assert.equal(rows.find(c=>c.id==='overlap').layer,1)
 assert.equal(rows.find(c=>c.id==='overlap').speaker_id,'spk_1')
 for(const args of [[0,500,'new','text','spk_1'],[1500,3000,'new','','spk_1'],[1500,3000,'new','text','spk_9']])
  assert.equal(tools.addSubtitleRange(document,{start:1,end:5},...args),null)
})

test('retiming never shifts hidden cues or the source time base',()=>{
 const rows=tools.retimeSubtitle(document.subtitles,'mixed',1400,4300,{start:1,end:5})
 assert.equal(rows[0],document.subtitles[0]);assert.equal(rows[1].start_ms,1400);assert.equal(rows[1].end_ms,4300)
 assert.equal(tools.retimeSubtitle(document.subtitles,'mixed',900,4300,{start:1,end:5}),null)
 assert.equal(tools.retimeSubtitle(document.subtitles,'mixed',1400,1400,{start:1,end:5}),null)
 assert.equal(tools.clockTime(3723.125),'62:03.125')
})
