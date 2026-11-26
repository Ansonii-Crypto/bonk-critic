import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('temporary save accepts incomplete forms; Push saves then publishes the draft',async()=>{
 const source=readFileSync(new URL('../../app.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('function wireForm('),source.indexOf('\nasync function edit(',source.indexOf('function wireForm(')));
 const temporary={},submit={},status={},error={},events=[];
 const data={name:'Draft',overall_tier:''};
 const form={isConnected:true,querySelector(selector){return {'[data-save-draft]':temporary,'button[type="submit"]':submit,'[data-draft-status]':status,'[data-tier-error]':error,'[data-assessment-tier]':{focus(){}}}[selector]||null}};
 const context=vm.createContext({document:{querySelector:()=>form},wireAutomaticTier(){data.overall_tier='F'},calculatedPlayerTier:()=> 'F',A:[],FormData:class{constructor(){return Object.entries(data)}},
  savePlayerDraft:async(form,state)=>{events.push('save draft');state.id='draft-id';state.revision=2},
  api:async(path,options)=>{events.push(path);assert.equal(JSON.parse(options.body).revision,2)},
  msg(){},adminTab:()=>events.push('players tab')});
 vm.runInContext(code,context);
 context.wireForm(null,null,false,{});
 await temporary.onclick();
 assert.deepEqual(events,['save draft']);
 assert.match(status.textContent,/Other admins/);
 await temporary.onclick();
 assert.equal(status.textContent,'Draft changes saved.');
 data.overall_tier='S';
 await form.onsubmit({preventDefault(){}});
 assert.deepEqual(events,['save draft','save draft','save draft','/api/player-drafts/draft-id/push','players tab']);
});

test('existing assessments calculate their tier on submit instead of trusting a saved selection',async()=>{
 const source=readFileSync(new URL('../../app.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('function wireForm('),source.indexOf('\nasync function edit(',source.indexOf('function wireForm(')));
 const keys=['control','execution','defending','reaction_time','chemistry','game_sense'];
 for(const isNew of [false,true]){
  const data={name:'Player',overall_tier:'S',...Object.fromEntries(keys.map(key=>[key,'200']))};
  const submit={},calls=[];
  const form={isConnected:true,querySelector:selector=>selector==='button[type="submit"]'?submit:null};
  let automatic=0;
  const context=vm.createContext({document:{querySelector:()=>form},wireAutomaticTier(){automatic++},calculatedPlayerTier:()=> 'D',A:keys.map(key=>[key]),FormData:class{constructor(){return Object.entries(data)}},setInterval(){return 0},
   api:async(path,options)=>calls.push({path,options}),msg(){},adminPlayerAssessments:id=>calls.push(id)});
  vm.runInContext(code,context);
  context.wireForm('existing',7,isNew);
  await form.onsubmit({preventDefault(){}});
  assert.equal(automatic,1);
  assert.equal(calls[0].path,'/api/players/existing');
  assert.equal(calls[0].options.method,'PUT');
  const submitted=JSON.parse(calls[0].options.body);
  assert.equal(submitted.overall_tier,'D');
  assert.equal(submitted.control,200);
  if(isNew)assert.equal(submitted.new_assessment,true);
  else assert.equal(submitted.assessment_id,7);
 }
});

test('existing assessment and draft forms display a calculated read-only tier',()=>{
 const source=readFileSync(new URL('../../app.js',import.meta.url),'utf8');
 const picker=source.slice(source.indexOf('function tierSelect('),source.indexOf('function calculatedPlayerTier('));
 const form=source.slice(source.indexOf('function form('),source.indexOf('function selectAdminTab('));
 const context=vm.createContext({esc:String,A:[],field:()=>'',classSelect:()=>'',localToday:()=> '2026-11-25',calculatedPlayerTier:()=> 'D'});
 vm.runInContext(picker+'\n'+form,context);
 for(const input of [{id:'existing',overall_tier:'S'},{overall_tier:'S'},{}]){
  const html=context.form(input);
  assert.match(html,/name="overall_tier" value="D"/);
  assert.equal((html.match(/data-assessment-tier="[SABCDEF]" disabled/g)||[]).length,7);
  assert.match(html,/data-assessment-tier="D" disabled aria-pressed="true"/);
  assert.doesNotMatch(html,/Select one tier|Click it again to clear/);
 }
});

test('other admins preview read-only; authors can confirm or cancel discarding',async()=>{
 const controls=[{},{}],actions={hidden:false,prepend(button){this.discard=button}},heading={textContent:'Draft by Author'},submit={disabled:false};
 const form={isConnected:true,querySelectorAll:()=>controls,querySelector:key=>key==='.new-player-actions'?actions:submit};
 const container={querySelector:key=>key==='#pf'?form:key==='.draft-heading p'?heading:{}};
 let allowed=false,calls=[];
 const context=vm.createContext({adminViewVersion:0,document:{querySelector:()=>container,createElement:()=>({})},esc:String,form:()=>'',wireForm(){},wireAutomaticTier(){},appConfirm:async()=>allowed,msg(){},api:async(path,options)=>calls.push([path,options.method])});
 vm.runInContext(readFileSync(new URL('../../drafts.js',import.meta.url),'utf8'),context);
 context.newPlayerPage=async()=>{};
 const draft={id:'saved',owner_id:'author',owner_name:'Author',revision:1,data:{}};
 context.openPlayerDraft(draft,'viewer');
 assert.ok(controls.every(control=>control.disabled));assert.equal(actions.hidden,true);assert.match(heading.textContent,/Read-only/);assert.equal(actions.discard,undefined);
 context.openPlayerDraft(draft,'author');
 assert.equal(actions.discard.className,'danger');
 await actions.discard.onclick();assert.equal(calls.length,0);
 allowed=true;await actions.discard.onclick();assert.deepEqual(calls,[['/api/player-drafts/saved','DELETE']]);
});


test('draft saving replaces an obsolete hidden tier with the calculated tier',async()=>{
 const data={name:'Saved draft',overall_tier:'S',control:'200'};
 const state={id:'draft',revision:2};
 let submitted;
 const context=vm.createContext({FormData:class{constructor(){return Object.entries(data)}},calculatedPlayerTier:values=>{assert.equal(values.control,'200');return 'D'},
  api:async(path,options)=>{submitted={path,options};return {id:'draft',revision:3}}});
 vm.runInContext(readFileSync(new URL('../../drafts.js',import.meta.url),'utf8'),context);
 await context.savePlayerDraft({},state);
 assert.equal(submitted.path,'/api/player-drafts/draft');
 assert.equal(JSON.parse(submitted.options.body).data.overall_tier,'D');
 assert.equal(state.revision,3);
});

test('automatic player tiers use all six attributes at every fixed score boundary and update on input',()=>{
 const source=readFileSync(new URL('../../app.js',import.meta.url),'utf8');
 const tierLine=source.split('\n').find(line=>line.startsWith('const tier='));
 const helper=source.slice(source.indexOf('function calculatedPlayerTier('),source.indexOf('function form('));
 const keys=['control','execution','defending','reaction_time','chemistry','game_sense'];
 const fields=Object.fromEntries(keys.map(key=>[key,{value:'200',addEventListener(event,handler){this.update=handler}}]));
 const input={},buttons='SABCDEF'.split('').map(rank=>({dataset:{assessmentTier:rank},setAttribute(key,value){this[key]=value}}));
 const ctx=vm.createContext({A:keys.map(key=>[key])});
 vm.runInContext(readFileSync(new URL('../../ratings.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(tierLine+'\n'+helper,ctx);
 const scores=total=>Object.fromEntries(keys.map((key,index)=>[key,Math.floor(total/6)+(index<total%6?1:0)]));
 for(const [total,expected] of [[0,'F'],[257,'F'],[258,'E'],[515,'E'],[516,'D'],[773,'D'],[774,'C'],[1157,'C'],[1158,'B'],[1295,'B'],[1296,'A'],[1535,'A'],[1536,'S'],[1800,'S']])assert.equal(ctx.calculatedPlayerTier(scores(total)),expected);
 const form={querySelector(selector){if(selector==='[name="overall_tier"]')return input;return fields[selector.match(/name="([^"]+)"/)[1]]},querySelectorAll:()=>buttons};
 ctx.wireAutomaticTier(form);assert.equal(input.value,'B');
 for(const [key,value] of Object.entries(scores(1536)))fields[key].value=String(value);
 fields.control.update();assert.equal(input.value,'S');assert.equal(buttons.filter(b=>b['aria-pressed']).length,1);
});
