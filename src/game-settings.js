// Exact input identity plus fresh readback: never verify a browser action by copying
// the requested value into an in-memory state. The function is also used by DOM tests.
export function inspectSettings(operation={}) {
  const deep=(sel,root=document,out=[])=>{out.push(...root.querySelectorAll(sel));for(const e of root.querySelectorAll('*'))if(e.shadowRoot)deep(sel,e.shadowRoot,out);return out;};
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';};
  const fields={};
  for(const e of deep('input')) {
    if(!visible(e)||e.hasAttribute?.('data-hg-skeleton'))continue;
    const root=e.getRootNode();
    const ids=(e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean);
    const label=norm([e.getAttribute('aria-label'),...ids.map(id=>root.getElementById?.(id)?.textContent)].join(' '));
    let kind=null;
    if(/^bet amount$|^stake$|^wager$/i.test(label))kind='stake';
    else if(e.id==='hd-g-in-mult'||/^(target )?multiplier$|^payout$/i.test(label))kind='multiplier';
    else if(e.id==='hd-g-in-chance'||/^(win\s*)?chance(?:,?\s*percent)?$|^peluang( menang)?$/i.test(label))kind='winChance';
    if(kind){
      const prev=fields[kind];
      const locked=e=>!!(e&&(e.disabled||e.readOnly));
      // A disabled empty skeleton must not hide the real stake field behind it.
      if(!prev||(locked(prev)&&!locked(e)))fields[kind]=e;
    }
  }
  if(operation.kind){
    const e=fields[operation.kind];
    if(!e)return {ok:false,error:`No ${operation.kind} control on this table`};
    if(e.disabled||e.readOnly){
      const current=String(e.value).trim();
      if(current!==''&&Number(current)===operation.value)return {ok:true,unchanged:true};
      // Empty while the table is still painting. A real non-zero lock is a hard stop.
      if(current===''||!Number.isFinite(Number(current)))return {ok:false,pending:true,error:`${operation.kind} control is not ready`};
      return {ok:false,error:`${operation.kind} control is locked at ${current}`};
    }
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(setter)setter.call(e,String(operation.value));else e.value=String(operation.value);
    e.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    e.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    e.dispatchEvent(new Event('blur',{bubbles:true,composed:true}));
  }
  const result={ok:true,url:location.href};
  for(const k of ['stake','multiplier','winChance']){
    const text=String(fields[k]?.value??'').trim();
    result[k]=text!==''&&Number.isFinite(Number(text))?Number(text):null;
    result[k+'Present']=!!fields[k];
  }
  return result;
}
export async function readSettings(page){
  if(!page||page.isClosed?.())return {ok:false,error:'No game page'};
  try{return await page.evaluate(inspectSettings,{});}catch(e){return {ok:false,error:e.message};}
}
export async function setSetting(page,kind,value){
  const v=Number(value);
  if(!['stake','multiplier','winChance'].includes(kind)||!Number.isFinite(v)||value===null||value==='')return {ok:false,error:'Invalid setting'};
  if(kind==='stake'&&v!==0)return {ok:false,error:'Live demo stake is locked to zero'};
  if(kind==='multiplier'&&(v<=1||v>1000))return {ok:false,error:'Multiplier outside 1..1000'};
  if(kind==='winChance'&&(v<1||v>99))return {ok:false,error:'Chance outside 1..99'};
  if(!page||page.isClosed?.())return {ok:false,error:'No game page'};
  try{
    const applied=await page.evaluate(inspectSettings,{kind,value:v});
    if(!applied.ok)return applied;
    await new Promise(r=>setTimeout(r,100));
    const readback=await readSettings(page),observed=readback[kind];
    const ok=readback.ok&&observed!==null&&observed!==undefined&&Math.abs(observed-v)<1e-7;
    return {ok,observed,verified:ok,settings:readback,...(ok?{}:{error:`${kind} readback ${observed}, requested ${v}`})};
  }catch(e){return {ok:false,error:e.message};}
}
export const zeroStake=page=>setSetting(page,'stake',0);
