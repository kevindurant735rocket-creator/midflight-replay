import fs from 'node:fs';
import readline from 'node:readline';
const t0 = Date.now();
function parseCodex(rl){
  const steps=[]; const calls=new Map(); const errors=[];
  let line=0, lastTs=0, ctxWin=0, cum=0;
  return (async()=>{
    for await (const l of rl){
      line++;
      let o; try{ o=JSON.parse(l);}catch(e){ errors.push({line,err:'badjson'}); continue; }
      const ts=Date.parse(o.timestamp)||lastTs; lastTs=ts;
      const p=o.payload||{}; const pt=p.type;
      if(o.type==='session_meta'){ ctxWin=p.context_window?.effective||ctxWin; steps.push({k:'head',ts,cwd:p.cwd}); }
      else if(o.type==='response_item'&&pt==='message') steps.push({k:p.role==='user'?'user':'ai',ts,txt:(p.content||[]).map(c=>c.text||c.type).join('')});
      else if(o.type==='response_item'&&pt==='reasoning') steps.push({k:'reason',ts,txt:(p.summary||[]).map(s=>s.text||'').join('')});
      else if(o.type==='response_item'&&pt==='function_call'){ calls.set(p.call_id,steps.length); steps.push({k:'call',ts,id:p.call_id,name:p.name,args:(p.arguments||'').length}); }
      else if(o.type==='response_item'&&pt==='function_call_output'){ const i=calls.get(p.call_id); steps.push({k:'out',ts,pair:i,bytes:(p.output||'').length}); }
      else if(o.type==='event_msg'&&pt==='token_count'){ const u=p.info?.last_token_usage; if(u){cum+=u.total||0; steps.push({k:'use',ts,tot:cum,cw:p.info?.model_context_window||ctxWin});} }
      else if(o.type==='event_msg'&&pt==='task_complete') steps.push({k:'turnend',ts,ms:p.duration_ms});
      else steps.push({k:'?',ts,t:o.type+'/'+pt});
    }
    return {steps,errors,line,ctxWin};
  })();
}
function parseClaude(rl){
  const steps=[]; const errors=[]; let line=0;
  return (async()=>{
    for await (const l of rl){
      line++;
      let o; try{o=JSON.loads?null:JSON.parse(l);}catch(e){ errors.push({line,err:'badjson'}); continue; }
      const ts=Date.parse(o.timestamp)||0;
      for (const b of (o.message?.content||[])){
        if(b.type==='text') steps.push({k:o.type==='user'?'user':'ai',ts,txt:b.text});
        else if(b.type==='tool_use') steps.push({k:'call',ts,id:b.id,name:b.name,args:JSON.stringify(b.input||{}).length});
        else if(b.type==='tool_result') steps.push({k:'out',ts,bytes:JSON.stringify(b.content||'').length});
        else if(b.type==='redacted_thinking') steps.push({k:'reason',ts,txt:'[redacted]'});
      }
      if(o.type==='file-history-snapshot') steps.push({k:'fhist',ts});
    }
    return {steps,errors,line};
  })();
}
const [,,file,kind] = process.argv;
const rl = readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
const r = kind==='claude' ? await parseClaude(rl) : await parseCodex(rl);
const kinds={}; for(const s of r.steps) kinds[s.k]=(kinds[s.k]||0)+1;
console.log(JSON.stringify({file:file.split('/').pop(),mb:+(fs.statSync(file).size/1048576).toFixed(1),lines:r.line,steps:r.steps.length,kinds,errors:r.errors.length,ctxWin:r.ctxWin,ms:Date.now()-t0,rssMB:+(process.memoryUsage().rss/1048576).toFixed(0)}));
