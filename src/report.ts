import type { ReplayStep, Session } from './types.js';
import { thin, thinBanner, type ThinOptions } from './compact.js';
import { buildContextTrack, projectContextTrack, CATEGORIES, CATEGORY_LABEL } from './context.js';
import { computeCoverage, VERDICT_LABEL } from './coverage.js';
import { postmortem } from './postmortem.js';
import { isEditTool, diffFromArgs } from './diff.js';

export interface ReportOptions extends ThinOptions {
  /** hard ceiling for the produced file; contract red line 3 */
  maxBytes?: number;
  /** provenance line, e.g. the input path */
  sourceLabel?: string;
}

export interface ReportResult {
  html: string;
  bytes: number;
  kept: number;
  total: number;
  coverageVerdict: string;
}

/**
 * Data goes into the page as one inline `<script>`, so a `<` inside a tool output is not
 * inert text: the HTML tokenizer reads `<!--` as "script data escaped" and `<script` as
 * "double escaped", and from that state the document's own `</script>` no longer closes the
 * element. The whole app then sits inside one unparsable script and the report opens blank.
 * Measured on a real 3,976-step Codex session that mentioned `<!--` and `<script` in tool
 * output: 2.2 MB of script text, zero page errors, zero DOM, no visible reason.
 *
 * Escaping only `</` is not enough — that was the previous version here, and it left both
 * entry points open. Every `<` becomes `\u003c`, which JSON and JS both decode back to `<`,
 * so the data round-trips byte-for-byte and the tokenizer can never leave script data state.
 */
const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

export function buildReport(session: Session, opts: ReportOptions = {}): ReportResult {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const t = thin(session.steps, opts);
  // Measure context on the FULL session, then project onto the kept timeline. Building it
  // from t.steps would let the thinned-away usage/tool_output rows flatten the curve.
  const ctx = projectContextTrack(buildContextTrack(session.steps), t.keptIdx);
  const coverage = computeCoverage(t.steps, session.meta.agent, session.fileHistory);

  // pre-resolve which steps are edits, so the browser only diffs what it must
  const payload = {
    meta: session.meta,
    steps: t.steps,
    ctx: {
      cumulative: ctx.cumulative,
      firstStep: ctx.firstStep,
      evaporated: ctx.evaporated,
      hasFirstHandCompaction: ctx.hasFirstHandCompaction,
      unexplainedDrops: ctx.unexplainedDrops,
    },
    coverage,
    // Analysed on the SAME thinned timeline the report shows, so a finding's step number
    // is a step the reader can click. Counting on the full session would point at rows
    // that are not in this file.
    postmortem: postmortem(t.steps),
    thin: {
      kept: t.kept,
      total: t.total,
      truncated: t.truncated,
      // Named so the banner can say which kinds are gone, not just how many steps.
      droppedByKind: t.droppedByKind,
      banner: t.truncated ? thinBanner(t.kept, t.total, t.droppedByKind) : '',
    },
    // Steps the adapter could not classify. These are *not* dropped — they are
    // rendered and scrubbable — but a reader seeing them labelled "unknown"
    // reasonably assumes the parser broke, so the header says what they are.
    unknownCount: t.steps.filter((st) => st.kind === "unknown").length,
    parseErrorCount: session.parseErrors.length,
    parseErrorSample: session.parseErrors.slice(0, 5).map((e) => ({ line: e.line, error: e.error })),
    warnings: session.warnings.slice(0, 8),
    sourceLabel: opts.sourceLabel ?? session.meta.sourceFile ?? '(stdin)',
    cats: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABEL[c] })),
  };

  const data = jsonForScript(payload);
  // Order matters: `__DATA__` lives inside the JS body, so JS must be spliced in first.
  // Function replacers: a JSON payload containing `$&` / `$'` must not be reinterpreted.
  const html = TEMPLATE
    .replace('/*__CSS__*/', () => CSS)
    .replace('/*__JS__*/', () => JS)
    .replace('/*__DATA__*/null', () => data);
  const bytes = Buffer.byteLength(html, 'utf8');

  if (bytes > maxBytes) {
    throw new Error(
      `report would be ${(bytes / 1048576).toFixed(2)} MiB, over the ${(maxBytes / 1048576).toFixed(0)} MiB ceiling. ` +
        `Refusing to ship a half report. Try --max-steps or --per-step-chars.`,
    );
  }
  return { html, bytes, kept: t.kept, total: t.total, coverageVerdict: coverage.verdict };
}

/** Exposed so the CLI can report coverage without building a full report. */
export function coverageOf(session: Session) {
  return computeCoverage(session.steps, session.meta.agent, session.fileHistory);
}
export { isEditTool, diffFromArgs, VERDICT_LABEL };

const CSS = `
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--acc:#58a6ff;
--c-conversation:#58a6ff;--c-reasoning:#bc8cff;--c-tool_output:#3fb950;--c-compaction:#f0883e;
--s-user:#79c0ff;--s-assistant:#e6edf3;--s-reasoning:#bc8cff;--s-tool_call:#d29922;--s-tool_output:#3fb950;
--s-usage:#6e7681;--s-turn_start:#f85149;--s-turn_end:#8b949e;--s-note:#a371f7;--s-compaction:#f0883e;--s-unknown:#6e7681}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{padding:14px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{font-size:15px;margin:0 0 6px;letter-spacing:.2px}
h1 small{color:var(--dim);font-weight:400;margin-left:8px}
.meta{color:var(--dim);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:8px}
.meta b{color:var(--fg);font-weight:600}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.badge{font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:10px;color:var(--dim)}
.badge.ok{border-color:#1f6f43;color:#3fb950}
.badge.warn{border-color:#8a5a00;color:#d29922}
.badge.err{border-color:#8b2c2c;color:#f85149}
.banner{margin-top:8px;padding:6px 10px;border-left:3px solid var(--c-compaction);background:#1c1400;color:#f0b972;font-size:12px}
.cov{margin-top:10px;border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:#0b0f14}
.cov .bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden;margin:6px 0}
.cov .fill{height:100%;background:var(--acc)}
.cov.full .fill{background:#3fb950}.cov.partial .fill{background:#d29922}.cov.diff-only .fill{background:#f85149}
.cov .why{color:var(--dim);font-size:12px}
.pm{margin-top:8px;border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:#0b0f14}
.pm-row{display:flex;gap:6px;align-items:baseline;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px}
.pm-row:hover{background:#161b22}
.pm-row .tag{flex:none}
.pm-row .pm-step{flex:none;margin-left:auto;color:var(--dim);white-space:nowrap}
.pm .why{color:var(--dim);font-size:12px;margin-top:6px}
.pm-clean{color:var(--dim);font-size:12px}
main{display:grid;grid-template-columns:1fr 1fr;gap:0;height:calc(100vh - 150px)}
@media(max-width:900px){main{grid-template-columns:1fr;height:auto}}
.pane{overflow:auto;padding:0 0 40px}
.pane.left{border-right:1px solid var(--line)}
.axiswrap{padding:10px 14px;border-bottom:1px solid var(--line);background:#0b0f14}
.axlabel{display:flex;justify-content:space-between;color:var(--dim);font-size:11px;margin-bottom:4px}
svg{display:block;width:100%;cursor:crosshair}
.legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:6px;font-size:11px;color:var(--dim);cursor:pointer}
.legend span{display:flex;align-items:center;gap:4px;padding:1px 4px;border-radius:3px}
.legend span:hover{background:#21262d}
.swatch{width:9px;height:9px;border-radius:2px;display:inline-block}
.rows{padding:0}
.row{display:grid;grid-template-columns:52px 92px 1fr;gap:8px;padding:4px 14px;border-bottom:1px solid #1c2128;cursor:pointer;align-items:start}
.row:hover{background:#12171d}
.row.sel{background:#132133;box-shadow:inset 3px 0 0 var(--acc)}
.row .i{color:var(--dim);font-variant-numeric:tabular-nums;font-size:11px}
.row .k{font-size:11px}
.row .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d1d9}
.detail{padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
.detail h2{font-size:13px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.tag{font-size:10px;padding:1px 6px;border-radius:8px;background:#21262d;color:var(--dim)}
pre{margin:6px 0;padding:8px;background:#0b0f14;border:1px solid var(--line);border-radius:5px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.diff{border:1px solid var(--line);border-radius:5px;overflow:auto;max-height:340px;margin:6px 0}
.diff div{padding:0 8px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.diff .add{background:#12261a;color:#7ee787}.diff .del{background:#2d1214;color:#ffa198}.diff .ctx{color:var(--dim)}
.diff .ln{color:#484f58;user-select:none;display:inline-block;width:3.2em;text-align:right;margin-right:8px}
.kv{color:var(--dim);font-size:12px;margin:4px 0}
.kv b{color:var(--fg)}
.warn{color:#d29922}.err{color:#f85149}
.hint{color:var(--dim);font-size:11px;margin-top:6px}
.empty{color:var(--dim);padding:20px 14px}
.ghost{background:repeating-linear-gradient(45deg,transparent,transparent 4px,#1c2128 4px,#1c2128 8px)}
`;

const JS = String.raw`
const D = /*__DATA__*/null;
const S = D.steps, N = S.length;
const KIND_COLOR = {user:"--s-user",assistant:"--s-assistant",reasoning:"--s-reasoning",tool_call:"--s-tool_call",
  tool_output:"--s-tool_output",usage:"--s-usage",turn_start:"--s-turn_start",turn_end:"--s-turn_end",
  note:"--s-note",compaction:"--s-compaction",file_event:"--s-tool_call",unknown:"--s-unknown"};
const KIND_CN = {user:"用户",assistant:"助手",reasoning:"推理",tool_call:"工具调用",tool_output:"工具输出",
  usage:"用量",turn_start:"轮次开始",turn_end:"轮次结束",note:"事件",compaction:"上下文压缩",
  file_event:"文件",unknown:"未知"};
const el = (t,cls,h)=>{const e=document.createElement(t); if(cls)e.className=cls; if(h!=null)e.innerHTML=h; return e;};
const esc = s => String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const kb = n => n>1e6 ? (n/1048576).toFixed(1)+"M" : n>1e3 ? (n/1024).toFixed(1)+"k" : String(n);
const kindOf = i => (S[i]||{}).kind || "unknown";
const colorOf = i => "var("+(KIND_COLOR[kindOf(i)]||"--s-unknown")+")";
let cur = -1, playing = false, timer = null;

/* ---- minimal LCS diff, ported from src/diff.ts so the browser owns the compute ---- */
function lcs(a,b){ if(a.length*b.length>400000) return null;
  const n=a.length,m=b.length,dp=Array.from({length:n+1},()=>new Array(m+1).fill(0));
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--) dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const o=[];let i=0,j=0;
  while(i<n&&j<m){ if(a[i]===b[j]){o.push(["ctx",a[i],String(i+1)]);i++;j++;}
    else if(dp[i+1][j]>=dp[i][j+1]){o.push(["del",a[i],String(i+1)]);i++;} else {o.push(["add",b[j],String(j+1)]);j++;} }
  while(i<n)o.push(["del",a[i],String(i+1)]),i++; while(j<m)o.push(["add",b[j],String(j+1)]),j++; return o; }
const EDIT_RE = /\b(edit|write|multiedit|notebookedit|apply_patch|str_replace)\b/i;
function diffFor(s){
  if(s.kind!=="tool_call"||!EDIT_RE.test(s.name||"")) return null;
  let a=null; try{a=JSON.parse(s.rawArgs||"")}catch(e){}
  // s.newText is the same string already lifted out of the args and clipped on its own, so it
  // still exists when per-step clipping has made rawArgs unparseable.
  const nw = (typeof s.newText==="string"&&s.newText!==""?s.newText:null)
    || (a && (typeof a.new_string==="string"?a.new_string:typeof a.newText==="string"?a.newText:typeof a.content==="string"?a.content:null));
  if(nw==null) return null;
  const log = a && (typeof a.old_string==="string"?a.old_string:typeof a.oldText==="string"?a.oldText:null);
  // P0-1: when the log carried no old_string, the before-image may have been recovered from
  // the host's own backup store. The badge says which one, because they are not equally strong.
  const rec = (log==null && typeof s.beforeImage==="string" && s.beforeImage!=="") ? s.beforeImage : null;
  const od = log!=null ? log : rec;
  const src = log!=null ? "log" : "file-history";
  const nb=nw.split("\n");
  if(od!=null){ const d=lcs(od.split("\n"),nb); if(d) return {recon:true,lines:d,src:src};
    return {recon:true,lines:od.split("\n").map((t,i)=>["del",t,String(i+1)]).concat(nb.map((t,i)=>["add",t,String(i+1)])),src:src}; }
  return {recon:false,lines:nb.map((t,i)=>["add",t,String(i+1)]),src:src};
}

/* ---- dual axis (AC-3b) ---- */
function drawAxes(){
  const wrap = el("div","axiswrap");
  const t0 = S.length? S[0].ts : 0, t1 = S.length? S[N-1].ts : 1, span = Math.max(1, t1-t0);

  const l1 = el("div","axlabel");
  l1.innerHTML = "<span>主轴 · 步骤时间线（"+kb(N)+" 步）</span><span>点击任一步查看详情</span>";
  wrap.appendChild(l1);
  const s1 = document.createElementNS("http://www.w3.org/2000/svg","svg");
  s1.setAttribute("viewBox","0 0 1000 34"); s1.setAttribute("preserveAspectRatio","none"); s1.setAttribute("height","34");
  for(let i=0;i<N;i++){ const r=document.createElementNS("http://www.w3.org/2000/svg","rect");
    const x=N>1? i/(N-1)*1000 : 0, w=Math.max(1000/N,0.6);
    r.setAttribute("x",x); r.setAttribute("y","0"); r.setAttribute("width",w); r.setAttribute("height","34");
    r.setAttribute("fill",colorOf(i)); r.setAttribute("data-i",i); r.setAttribute("opacity", kindOf(i)==="usage"?0.5:0.92);
    s1.appendChild(r); }
  s1.addEventListener("click",e=>{const t=e.target.getAttribute("data-i"); if(t!==null) select(+t);});
  wrap.appendChild(s1);

  const l2 = el("div","axlabel"); l2.style.marginTop="10px"; l2.style.display="block"; l2.style.lineHeight="1.7";
  const cg = D.ctx;
  l2.innerHTML = "<span>副轴 · 上下文占用（按字符数估算，不是精确 token 数）</span><span>"+
    (cg.hasFirstHandCompaction ? "⇣ 第一手压缩事件 "+cg.evaporated.filter(x=>x>0).length+" 次" : "未观测到压缩事件")+
    " · 点击色块跳到该类内容首次进入上下文的一步"+
    (D.thin&&D.thin.truncated ? " · 已抽稀会话：曲线在<b>全量</b>步上测量后按显示点采样，不受丢弃影响" : "")+
    "</span>";
  wrap.appendChild(l2);
  const s2 = document.createElementNS("http://www.w3.org/2000/svg","svg");
  s2.setAttribute("viewBox","0 0 1000 34"); s2.setAttribute("preserveAspectRatio","none"); s2.setAttribute("height","34");
  let maxTot = 1;
  for(let i=0;i<N;i++){ const c=cg.cumulative[i]; if(c){ let t=0; for(const v of c) t+=v; if(t>maxTot) maxTot=t; } }
  const colors=["--c-conversation","--c-reasoning","--c-tool_output","--c-compaction"];
  // Stacked, not overlapping: each band sits on the sum of the bands below it, so the total
  // silhouette is the whole context and a band's thickness is its share. Drawing every band
  // from one baseline made the big one swallow the small ones and misrepresented composition.
  const base=new Array(N).fill(0);
  for(let k=0;k<D.cats.length;k++){
    let d="";
    for(let i=0;i<N;i++){ const v=(cg.cumulative[i]||[])[k]||0; const x=N>1? i/(N-1)*1000:0; const y=34-((base[i]+v)/maxTot)*34; d+=(i?"L":"M")+x.toFixed(2)+","+y.toFixed(2); }
    for(let i=N-1;i>=0;i--){ const x=N>1? i/(N-1)*1000:0; const y=34-(base[i]/maxTot)*34; d+="L"+x.toFixed(2)+","+y.toFixed(2); }
    d+="Z";
    for(let i=0;i<N;i++) base[i]+=(cg.cumulative[i]||[])[k]||0;
    const p=document.createElementNS("http://www.w3.org/2000/svg","path");
    p.setAttribute("d",d); p.setAttribute("fill","var("+colors[k]+")"); p.setAttribute("opacity","0.62");
    p.setAttribute("data-cat",k); p.style.cursor="pointer"; s2.appendChild(p);
  }
  s2.addEventListener("click",e=>{const k=e.target.getAttribute("data-cat");
    if(k===null)return; const fs=cg.firstStep[+k]; if(fs>=0) select(fs); });
  wrap.appendChild(s2);

  const lg = el("div","legend");
  D.cats.forEach((c,k)=>{ const sp=el("span"); sp.innerHTML='<i class="swatch" style="background:var('+colors[k]+')"></i>'+esc(c.label);
    sp.title="首次进入：第 "+(cg.firstStep[k]>=0? cg.firstStep[k]+1 : "—")+" 步";
    sp.addEventListener("click",()=>{ const fs=cg.firstStep[k]; if(fs>=0) select(fs); }); lg.appendChild(sp); });
  const gh=el("span"); gh.innerHTML='<i class="swatch ghost"></i>压缩时丢弃的内容'; lg.appendChild(gh);
  wrap.appendChild(lg);
  return wrap;
}

/* ---- step list (windowed) ---- */
const WIN=80;
function drawRows(){
  const box = el("div","rows");
  const paint = ()=>{
    box.innerHTML="";
    if(cur<0){ box.appendChild(el("div","empty","← / → 或点击上方时间线选择一步")); return; }
    const start=Math.max(0,cur-Math.floor(WIN/2)), end=Math.min(N,start+WIN);
    for(let i=start;i<end;i++){
      const s=S[i], k=kindOf(i);
      const r=el("div","row"+(i===cur?" sel":""));
      const prev = i>0? S[i-1].ts : s.ts;
      const dt = i>0? " +"+Math.max(0,Math.round((s.ts-prev)/1000))+"s" : "";
      r.innerHTML='<div class="i">#'+(i+1)+'</div><div class="k" style="color:'+colorOf(i)+'">'+esc(KIND_CN[k]||k)+
        (k==="compaction"?" ⇣":"")+'</div><div class="p">'+esc(preview(s))+'</div>';
      r.title="t+"+dt;
      r.dataset.i = String(i);
      r.addEventListener("click",()=>select(i));
      box.appendChild(r);
    }
    const s=S[cur];
    if(s&&s.kind==="compaction"){
      const g=el("div","row ghost"); g.innerHTML='<div class="i"></div><div class="k" style="color:var(--c-compaction)">压缩丢弃</div><div class="p">丢弃 '+
        kb(D.ctx.evaporated[cur]||0)+' 字符 →</div>'; box.insertBefore(g, box.children[cur-start]||null);
    }
  };
  box._paint=paint; paint(); return box;
}
function preview(s){
  switch(s.kind){
    case "user": case "assistant": return s.text;
    case "reasoning": return s.summary;
    case "tool_call": return s.name+"  "+String(s.args||"").slice(0,160);
    case "tool_output": return String(s.output||"").slice(0,200);
    case "usage": return "in "+kb(s.input)+" (cached "+kb(s.cachedInput)+") · out "+kb(s.output)+" · total "+kb(s.total);
    case "turn_start": return "model="+(s.model||"?")+" effort="+(s.effort||"?");
    case "turn_end": return "duration="+(s.durationMs!=null?Math.round(s.durationMs/1000)+"s":"?")+" ttft="+(s.ttftMs!=null?Math.round(s.ttftMs/1000)+"s":"—");
    case "compaction": return "⇣ "+String(s.summary||"").slice(0,180);
    case "note": return (s.level==="warn"?"⚠ ":s.level==="error"?"✕ ":"· ")+s.text;
    case "file_event": return s.op+" "+s.path;
    default: return String(s.raw||"");
  }
}

/* ---- detail panel (AC-3 / AC-3c) ---- */
function detail(){
  const box = el("div","detail");
  box.id = "detail"; // select() swaps this node in; without the id the pane never updates
  if(cur<0){ box.innerHTML='<h2>详情</h2><div class="empty">未选择步骤</div>'; return box; }
  const s=S[cur], k=s.kind;
  let h='<h2><span class="tag" style="color:'+colorOf(cur)+'">'+esc(KIND_CN[k]||k)+'</span>第 '+(cur+1)+' / '+N+' 步</h2>';
  h += '<div class="kv">时间 <b>'+new Date(s.ts).toISOString().replace("T"," ").slice(0,19)+'</b>';
  if(s.ts-S[0].ts>=0) h += ' · 相对 <b>+'+fmtDur(s.ts-S[0].ts)+'</b>';
  if(k==="usage") h += ' · 上下文占用 <b>'+(s.contextWindow? (100*s.input/s.contextWindow).toFixed(1)+"% ("+kb(s.input)+"/"+kb(s.contextWindow)+")" : kb(s.input))+'</b>';
  h += '</div>';
  if(s.kind==="reasoning"||s.kind==="user"||s.kind==="assistant") h += "<pre>"+esc(s.text||s.summary)+"</pre>";
  if(s.kind==="tool_call"){
    h += '<div class="kv">工具 <b>'+esc(s.name)+'</b> · call_id <b>'+esc(s.callId)+'</b></div>';
    const d = diffFor(s);
    if(d){
      h += '<div class="kv">'+(d.recon
        ? (d.src==="file-history"
            ? '<span class="badge warn" title="日志本身没有 old_string；这一份 before-image 由宿主自己的备份（~/.claude/file-history）按内容比对还原，原始文件路径未记录。">before-image 来自 file-history 备份 · 可撤回（非日志内联）</span>'
            : '<span class="badge ok">before-image 可用 · 可撤回</span>')
        : '<span class="badge err">无 before-image · 仅 diff，不能逆放</span>')+
        (d.recon && d.src==="file-history" && s.beforeImageFrom ? ' <span class="badge">备份 '+esc(s.beforeImageFrom)+'</span>':'')+'</div>';
      h += '<div class="diff">'+d.lines.map(l=>'<div class="'+l[0]+'"><span class="ln">'+esc(String(l[2]??""))+'</span>'+(l[0]==="add"?"+":l[0]==="del"?"-":" ")+esc(l[1])+'</div>').join("")+'</div>';
    }
    h += "<pre>"+esc(String(s.args||""))+"</pre>";
  }
  if(s.kind==="tool_output") h += '<div class="kv">'+(s.truncated?'<span class="badge warn">已截断</span> ':'')+'</div><pre>'+esc(s.output)+"</pre>";
  if(s.kind==="usage") h += '<div class="kv">输入 <b>'+kb(s.input)+'</b>（缓存 '+kb(s.cachedInput)+'） · 输出 <b>'+kb(s.output)+'</b> · 推理 <b>'+kb(s.reasoning)+
    '</b> · 本次合计 <b>'+kb(s.total)+'</b>'+(s.threadTotal!=null?' · 线程累计 <b>'+kb(s.threadTotal)+'</b>':'')+'</div>';
  if(s.kind==="compaction") h += '<div class="kv"><span class="badge warn">⇣ 上下文压缩</span>'+
    (s.contextBefore!=null ? ' 宿主上报压缩前 <b>'+kb(s.contextBefore)+'</b> token' : ' 宿主未上报压缩前 token 数')+
    ' · 本次压缩丢弃 <b>'+kb(D.ctx.evaporated[cur]||0)+'</b> 字符（字符统计，不是 token）</div>'+
    (s.summary? '<pre>'+esc(s.summary)+'</pre>' : '');
  if(s.kind==="note") h += '<div class="'+(s.level==="info"?"kv":(s.level==="warn"?"kv warn":"kv err"))+'">'+esc(s.text)+"</div>";
  box.innerHTML=h; return box;
}
function fmtDur(ms){ const s=Math.round(ms/1000); if(s<60) return s+"s"; const m=Math.floor(s/60); return m+"m"+(s%60)+"s"; }

/* ---- selection / keyboard ---- */
let rowsEl;
function select(i){
  cur = Math.max(0, Math.min(N-1, i));
  const d=document.getElementById("detail"); if(d) d.replaceWith(detail());
  if(rowsEl) rowsEl._paint();
}
function move(d){ if(cur<0) select(0); else select(cur+d); }
function play(){
  if(playing) return stop();
  playing=true; timer=setInterval(()=>{ if(cur>=N-1){stop();return;} select(cur+1); }, 220);
  document.getElementById("play").textContent="⏸ 暂停";
}
function stop(){ playing=false; if(timer)clearInterval(timer); const b=document.getElementById("play"); if(b)b.textContent="▶ 播放"; }
document.addEventListener("keydown",e=>{
  if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA") return;
  const k=e.key;
  if(k===" "){e.preventDefault(); play();}
  else if(k==="ArrowRight"||k==="j"){e.preventDefault(); move(1);}
  else if(k==="ArrowLeft"||k==="k"){e.preventDefault(); move(-1);}
  else if(k==="Home"){e.preventDefault(); select(0);}
  else if(k==="End"){e.preventDefault(); select(N-1);}
  else if(k==="PageDown"){e.preventDefault(); move(20);}
  else if(k==="PageUp"){e.preventDefault(); move(-20);}
});

/* ---- header ---- */
function header(){
  const m=D.meta, c=D.coverage;
  const h=el("header");
  const metas=[["会话",m.sessionId],...(m.title?[["标题",m.title]]:[]),["host",m.agent],["模型",m.model||"—"],["effort",m.effort||"—"],
    ["版本",m.cliVersion||"—"],["分支",m.gitBranch||"—"],["上下文窗口",m.contextWindow?kb(m.contextWindow)+" token":"—"],
    ["来源",D.sourceLabel]];
  let hh='<h1>midflight <small>agent 会话回放 · 自动检查</small></h1><div class="meta">';
  for(const [k,v] of metas) hh+='<span>'+esc(k)+' <b>'+esc(String(v))+'</b></span>';
  hh+='</div>';
  hh+='<div class="badges">'+
    '<span class="badge ok">✓ 不写工作区</span><span class="badge ok">✓ 不引 git</span><span class="badge ok">✓ 不伪造快照</span>'+
    '<span class="badge '+(D.parseErrorCount? "warn":"ok")+'">'+(D.parseErrorCount? "⚠ "+D.parseErrorCount+" 行损坏（已保留其余）" : "✓ 0 行损坏")+'</span>'+
    (D.ctx.unexplainedDrops? '<span class="badge warn">'+D.ctx.unexplainedDrops+" 次未解释的上下文下降</span>":'')+
    (D.unknownCount? '<span class="badge ok" title="host 写入的会话元数据与未分类记录；已渲染并可拖动，不是解析失败。预算不足时会被 thin() 优先丢弃，丢弃量见下方提示。">'+D.unknownCount+
      ' 步为会话元数据 / 未分类（已渲染）</span>':'')+
    '</div>';
  // The bar answers "how much of what the session changed can I undo?", so it divides by
  // every change, shell-borne ones included. Using c.ratio here printed a full bar labelled
  // 100% on a session where the verdict below it said 0 of 238 changes are reversible.
  const denom=(c.totalChanges??(c.edits+c.shellMutations));
  const pct=Math.round((c.reversibleRatio??c.ratio)*100);
  // The prose above is a verdict; cov-nums prints the three counts it came from, so a
  // reader (or the README) never has to trust a claim they cannot check.
  hh+='<div class="cov '+c.verdict+'"><b>诚实覆盖条</b> · '+esc(c.verdict==="full"?"可撤回":c.verdict==="partial"?"部分可撤回":c.verdict==="diff-only"?"仅 diff":"无编辑")+
    ' · 可撤回 <b>'+pct+'%</b>（'+kb(c.withBefore??0)+' / '+kb(denom)+' 处改动）<div class="bar"><div class="fill" style="width:'+pct+'%"></div></div><div class="why">'+esc(c.reason)+'</div>'+
    '<div class="kv cov-nums" data-edits="'+c.edits+'" data-shell="'+c.shellMutations+'" data-before="'+c.withBefore+'" data-before-log="'+c.withBeforeLog+'" data-before-backup="'+c.withBeforeBackup+'" data-backups="'+c.backups+'">'+
    '结构化编辑 <b>'+c.edits+'</b> · shell 改动 <b>'+c.shellMutations+'</b> · 带 before-image <b>'+c.withBefore+'</b>'+
    (c.withBeforeBackup>0 ? '（日志内联 <b>'+c.withBeforeLog+'</b> + 备份还原 <b>'+c.withBeforeBackup+'</b>）' : '')+
    (c.backups===0 && c.edits>0 ? ' · 本机无该会话 file-history 备份' : '')+
    (c.missing>0 ? ' · 仍缺 <b>'+c.missing+'</b>' : '')+'</div></div>';
  if(D.postmortem&&D.postmortem.length){
    const PMK={loop:'死循环','repeated-edit':'反复改同一处','near-full-context':'上下文压力'};
    hh+='<div class="pm"><b>自动检查</b> · '+D.postmortem.length+' 项发现<div class="why">同一调用连续同参、同一文件被反复改、上下文逼近窗口上限。全部由日志计数得出，不是模型判断。</div>';
    for(const f of D.postmortem){
      hh+='<div class="pm-row" data-i="'+f.firstStep+'" title="'+esc(f.evidence.join(' / '))+'"><span class="tag">'+esc(PMK[f.kind]||f.kind)+'</span><span>'+esc(f.headline)+'</span><span class="pm-step">第 '+(f.firstStep+1)+' 步</span></div>';
    }
    hh+='</div>';
  } else {
    hh+='<div class="pm"><b>自动检查</b> · 未发现<div class="pm-clean">日志里没有同参连调、没有反复改同一处、没有上下文压力。</div></div>';
  }
  if(D.thin.banner) hh+='<div class="banner">'+esc(D.thin.banner)+'</div>';
  if(D.parseErrorCount) hh+='<div class="banner">部分行无法解析，已按可读部分渲染：'+D.parseErrorSample.map(p=>"行 "+p.line).join("、")+
    (D.parseErrorCount>5?" 等 "+D.parseErrorCount+" 行":"")+'。原始行号已记录，可用 midflight doctor 查看完整原因。</div>';
  h.innerHTML=hh;
  // Wired here, not on the global step list: these rows live in the header, and a
  // panel that renders findings nobody can reach is decoration.
  for(const r of h.querySelectorAll('.pm-row')){
    r.addEventListener('click',()=>{ const i=+r.getAttribute('data-i'); if(i>=0) select(i); });
  }
  return h;
}

document.body.appendChild(header());
const left=el("div","pane left");
left.appendChild(drawAxes());
const btn=el("button"); btn.id="play"; btn.textContent="▶ 播放";
btn.style.cssText="margin:8px 14px;padding:4px 12px;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;cursor:pointer";
btn.addEventListener("click",play);
left.appendChild(btn);
const hint=el("div","hint"); hint.style.margin="0 14px 8px";
hint.textContent="快捷键：空格 播放/暂停 · ←/→ 或 j/k 单步 · PageUp/PageDown 跳 20 步 · Home/End 首尾";
left.appendChild(hint);
rowsEl=drawRows(); left.appendChild(rowsEl);
const right=el("div","pane right"); right.appendChild(detail());
document.body.appendChild(mainWrap());
function mainWrap(){ const m=el("main"); m.appendChild(left); m.appendChild(right); return m; }
if(N) select(0);
`;

const TEMPLATE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>midflight · session replay</title>
<style>/*__CSS__*/</style>
</head><body>
<noscript><p style="padding:16px">This replay needs JavaScript. All data is embedded in this file; nothing is fetched from the network.</p></noscript>
<script>/*__JS__*/</script>
</body></html>`;
