const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
const root=path.join(__dirname,'../src/features/studio')
function load(name,mocks={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,name),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{exports,URL,Set,require:id=>mocks[id]||assert.fail(id)});return exports}
const helpers=load('referenceKnowledge.ts')
const fixture={id:'knowledge',revision:4,title:'接唱反应',explanation:'保留完整反应',triggers:['接唱'],context:'有铺垫',caution:'不推断人设',source_url:'https://www.bilibili.com/video/BV1z33BzUEBq/?p=2',evidence:{start_ms:6500,end_ms:8000,quote:'接唱'}}

test('reference URLs remove tracking, retain video parts and deduplicate',()=>{
 const urls=helpers.referenceUrls('https://www.bilibili.com/video/BV1z33BzUEBq/?p=2&vd_source=private\nhttps://bilibili.com/video/BV1z33BzUEBq/?p=2')
 assert.deepEqual(Array.from(urls),['https://www.bilibili.com/video/BV1z33BzUEBq/?p=2'])
 assert.equal(helpers.evidenceLink(fixture),'https://www.bilibili.com/video/BV1z33BzUEBq/?p=2&t=6')
 assert.equal(helpers.evidenceLink({...fixture,source_url:''}),undefined)
})
test('unsafe sources and invalid batch sizes are rejected before requests',()=>{
 for(const value of ['https://www.bilibili.com.evil/video/BV1z33BzUEBq/','http://www.bilibili.com/video/BV1z33BzUEBq/','https://www.bilibili.com/video/BV1z33BzUEBq/?p=0',Array(11).fill('https://www.bilibili.com/video/BV1z33BzUEBq/').join('\n')])assert.throws(()=>helpers.referenceUrls(value))
})
test('review preserves revision and only submits editable knowledge fields',()=>{
 const body=JSON.parse(JSON.stringify(helpers.reviewPayload(fixture,'confirmed')))
 assert.equal(body.revision,4);assert.equal(body.status,'confirmed')
 for(const key of ['source_url','evidence','id','subjects'])assert.equal(body[key],undefined)
 assert.equal(fixture.revision,4)
})
test('reference learning does not call a model until the user starts analysis',async()=>{
 const calls=[],jsx=(type,props)=>({type,props})
 const C=load('ReferenceLearning.tsx',{react:{useState:value=>[value,()=>{}],useEffect(){}},'react/jsx-runtime':{jsx,jsxs:jsx},
  '../../i18n':{t:x=>x},'../../ui':{Btn:'button',fmtDuration:String},'../../services/api':{default:{post:async(...args)=>calls.push(args)}},
  './api':{errorText:String},'./referenceKnowledge':helpers}).default
 const tree=C({query:'思诺snow'})
 const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)]
 assert.equal(calls.length,0)
 const button=nodes(tree).find(n=>n.type==='button'&&n.props.children==='分析并生成待确认条目')
 assert.ok(button);await button.props.onClick();assert.equal(calls.length,0)
})

test('knowledge polling and concurrent revisions preserve unsaved edits and the review revision',async()=>{
 const hooks=[],effects=[],calls=[],jsx=(type,props)=>({type,props});let index=0
 const react={useState(initial){const id=index++;if(!(id in hooks))hooks[id]=initial;return [hooks[id],value=>{hooks[id]=typeof value==='function'?value(hooks[id]):value}]},
  useEffect(effect,deps){const id=index++,old=hooks[id];if(!old||deps.some((value,i)=>value!==old[i])){hooks[id]=deps;effects.push(effect)}}}
 const C=load('ReferenceLearning.tsx',{react,'react/jsx-runtime':{jsx,jsxs:jsx},'../../i18n':{t:x=>x},'../../ui':{Btn:'button',fmtDuration:String},
  '../../services/api':{default:{patch:async(url,body)=>{calls.push(body);throw new Error('conflict')}}},'./api':{errorText:String},'./referenceKnowledge':helpers}).KnowledgeCard
 const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)]
 const item={...fixture,kind:'selection',subjects:'思诺snow',status:'confirmed'}
 const render=(current=item)=>{index=0;const tree=nodes(C({item:current,onSaved(){}}));effects.splice(0).forEach(effect=>effect());return tree}
 const button=(tree,label)=>tree.find(n=>n.type==='button'&&n.props.children===label)
 button(render(),'编辑').props.onClick()
 let tree=render();tree.find(n=>n.type==='textarea'&&n.props.value===item.explanation).props.onChange({target:{value:'Unsaved correction'}})
 tree=render({...item});assert.ok(tree.some(n=>n.type==='textarea'&&n.props.value==='Unsaved correction'))
 tree=render({...item,revision:5,explanation:'Concurrent correction'});assert.ok(tree.some(n=>n.type==='textarea'&&n.props.value==='Unsaved correction'))
 button(tree,'保存并启用').props.onClick();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(calls[0].revision,4);assert.equal(calls[0].explanation,'Unsaved correction')
})
