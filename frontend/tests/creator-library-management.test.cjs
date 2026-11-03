const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const exportsOf={}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/features/studio/creatorLibraryEditing.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:exportsOf})
const edit=exportsOf,clone=value=>JSON.parse(JSON.stringify(value))
const fixture=()=>({schema_version:1,revision:1,profiles:[{id:'a',name:'思诺',aliases:['snow'],background:'原背景',memes:'原梗',sources:[]}],terms:[],feedback:[]})
test('a stale profile editor preserves new feedback and other field edits',()=>{
 const base=fixture(),draft=clone(base),saved=clone(base)
 draft.profiles[0].background='我的背景';saved.profiles[0].memes='另一窗口的梗';saved.feedback.push({id:'f',title:'new'})
 const result=edit.rebaseLibrary(base,draft,saved)
 assert.equal(result.conflicts.length,0);assert.equal(result.library.profiles[0].background,'我的背景');assert.equal(result.library.profiles[0].memes,'另一窗口的梗');assert.equal(result.library.feedback.length,1)
 assert.equal(base.profiles[0].background,'原背景')
})
test('same-field and delete/edit conflicts require explicit per-field choices',()=>{
 const base=fixture(),draft=clone(base),saved=clone(base)
 draft.profiles[0].background='我的校对';saved.profiles[0].background='对方校对'
 let result=edit.rebaseLibrary(base,draft,saved);assert.equal(result.conflicts[0].key,'profiles:a:background')
 result=edit.rebaseLibrary(base,draft,saved,{'profiles:a:background':'local'})
 assert.equal(result.conflicts.length,0);assert.equal(result.library.profiles[0].background,'我的校对')
 draft.profiles=[];assert.equal(edit.rebaseLibrary(base,draft,saved).conflicts.length,1)
})
test('imports append new references without replacing manually corrected content',()=>{
 const profile=fixture().profiles[0],old={url:'https://example.org/old',title:'old',excerpt:'旧资料'}
 profile.sources=[old]
 const result=edit.importSources(profile,[{...old,excerpt:'网页新说法'},{url:'https://example.org/new',title:'new',excerpt:'新参考'}])
 assert.equal(result.background,'原背景\n\n新参考');assert.equal(result.memes,'原梗');assert.equal(result.sources.length,2);assert.equal(profile.sources.length,1)
})
test('lookup, staged import and saved import have distinct reference states',()=>{
 const base=fixture(),source={subject:'snow',url:'https://example.org/new',title:'new',excerpt:'新资料'}
 assert.equal(edit.containsReferences(base,[source]),false)
 const draft=clone(base);draft.profiles[0]=edit.importSources(draft.profiles[0],[source])
 assert.equal(edit.containsReferences(draft,[source]),true);assert.equal(edit.containsReferences(base,[source]),false)
 const saved=clone(draft);assert.equal(edit.containsReferences(saved,[source]),true)
 assert.equal(edit.containsReferences(saved,[{...source,subject:'其他角色'}]),false)
})
test('duplicate names and incomplete vocabulary are rejected before submission',()=>{
 const draft=fixture();draft.profiles.push({...clone(draft.profiles[0]),id:'b',name:'另一角色',aliases:['ＳＮＯＷ']})
 assert.equal(edit.libraryValidation(draft),'角色名称或别名重复，请修改后保存')
 draft.profiles.pop();draft.terms.push({correct:'',variants:[],scope:''});assert.equal(edit.libraryValidation(draft),'请填写词条的正确写法')
})
test('recovery only accepts valid unsaved snapshots and timestamps do not mark saved content dirty',()=>{
 const base=fixture(),draft=clone(base);draft.profiles[0].memes='未保存修订'
 const raw=JSON.stringify({version:2,base,draft,savedAt:'2026-11-03T00:00:00Z'})
 assert.equal(edit.readLibraryDraft(raw).draft.profiles[0].memes,'未保存修订')
 assert.equal(edit.readLibraryDraft('{broken'),null)
 assert.equal(edit.readLibraryDraft(JSON.stringify({version:2,base,draft:{...draft,terms:[null]},savedAt:'x'})),null)
 assert.equal(edit.sameContent(base,{...base,revision:2,updated_at:'now'}),true)
})
