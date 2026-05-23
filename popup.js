"use strict";
const $ = (s) => document.getElementById(s);
const statusEl=$("status"), statusText=$("status-text");
const btnClean=$("btn-clean"), btnPdf=$("btn-pdf");
const btnMd=$("btn-md"), btnHtml=$("btn-html"), btnClip=$("btn-clip");
const modeChip=$("mode-chip"), modeIcon=$("mode-icon"), modeText=$("mode-text");
const genOpts=$("general-opts");
const mSlider=$("m-slider"), mLabel=$("m-label");
const batchSelect=$("batch-select");

const MARGINS=[{l:"None",cm:0},{l:"Compact",cm:0.4},{l:"Comfortable",cm:0.8},{l:"Standard",cm:1.3},{l:"Wide",cm:2.0}];

function setStatus(msg,type){statusText.textContent=msg;statusEl.className="status"+(type?" "+type:"");}
async function activeTab(){
  // Get the real user tab, not the popup or extension page
  const tabs = await chrome.tabs.query({currentWindow:true});
  // Prefer the active non-extension tab
  const extUrl = chrome.runtime.getURL("");
  let userTab = tabs.find(t => t.active && !t.url.startsWith(extUrl) && !t.url.startsWith("chrome") && !t.url.startsWith("edge"));
  if (!userTab) userTab = tabs.filter(t => !t.url.startsWith(extUrl)).pop();
  return userTab || tabs[0];
}
function segVal(id){return document.querySelector(`#${id} .seg.on`)?.dataset.v??"";}
function enableExports(){[btnPdf,btnMd,btnHtml,btnClip].forEach(b=>b.disabled=false);btnClean.disabled=true;}
function getSettings(){
  const idx=parseInt(mSlider.value,10);
  const scaleRaw = document.getElementById("sel-scale")?.value || "auto";
  return {
    pageSize:segVal("sg-size")||"A4", orientation:segVal("sg-orient")||"portrait",
    marginCm:MARGINS[idx].cm,
    imageBreak:$("chk-img-break").checked, tableBreak:$("chk-tbl-break").checked,
    scaleOverride: scaleRaw === "auto" ? null : parseFloat(scaleRaw)
  };
}

// ── Init ────────────────────────────────────────────────────────────────────
let isScaler=false;
(async()=>{
  try{
    const tab=await activeTab();
    const url=new URL(tab.url);
    isScaler=url.hostname.includes("scaler.com");
    if(isScaler){modeChip.className="mode scaler";modeIcon.textContent="\u2713";modeText.textContent="Scaler Mode";genOpts.style.display="none";}
    else{genOpts.style.display="";}
    const[r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>window.__ES_CLEANED===true});
    if(r?.result){enableExports();setStatus("Page already cleaned \u2014 ready to export.","ok");}
  }catch(_){}
  const{theme}=await chrome.storage.local.get("theme");
  if(theme==="dark"||(theme==="system"&&matchMedia("(prefers-color-scheme:dark)").matches))
    document.documentElement.dataset.theme="dark";
  loadBatchList();
})();

// ── Segmented controls ──────────────────────────────────────────────────────
document.querySelectorAll(".seg-group").forEach(g=>{
  g.querySelectorAll(".seg").forEach(btn=>{
    btn.addEventListener("click",()=>{g.querySelectorAll(".seg").forEach(b=>b.classList.remove("on"));btn.classList.add("on");});
  });
});

function updateM(){mLabel.textContent=MARGINS[parseInt(mSlider.value,10)].l;}
mSlider.addEventListener("input",updateM);updateM();

// ── Clean ───────────────────────────────────────────────────────────────────
btnClean.addEventListener("click",async()=>{
  btnClean.disabled=true;setStatus("Scanning and removing elements\u2026","info");
  try{
    const tab=await activeTab();
    const cleanOpts={removeHeader:false,removeFooter:false,customSelectors:[]};
    if(!isScaler){cleanOpts.removeHeader=$("chk-header").checked;cleanOpts.removeFooter=$("chk-footer").checked;}
    const stored=await chrome.storage.local.get(["scalerPresets","customSelectors"]);
    if(stored.scalerPresets)cleanOpts.scalerPresets=stored.scalerPresets;
    try{
      const host=new URL(tab.url).hostname;
      if(stored.customSelectors?.[host]?.enabled)cleanOpts.customSelectors=stored.customSelectors[host].selectors||[];
    }catch(_){}
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:o=>{window.__ES_CLEAN_OPTS=o;},args:[cleanOpts]});
    const[res]=await chrome.scripting.executeScript({target:{tabId:tab.id},files:["cleaner.js"]});
    const count=res?.result??0;
    if(count===0){setStatus("No targeted elements found.","");btnClean.disabled=false;}
    else{setStatus(`Done \u2014 ${count} element${count===1?"":"s"} removed.`,"ok");enableExports();
      chrome.runtime.sendMessage({type:"recordHistory",url:tab.url,title:tab.title,format:"clean"});}
  }catch(e){console.error(e);setStatus("Cannot access this page.","err");btnClean.disabled=false;}
});

// ── PDF ─────────────────────────────────────────────────────────────────────
btnPdf.addEventListener("click",async()=>{
  btnPdf.disabled=true;setStatus("Preloading images \u2014 scrolling page\u2026","info");
  try{
    const tab=await activeTab(); const settings=getSettings();
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:o=>{window.__ES_SCROLL_OPTS=o;},args:[{expandHorizontal:true}]});
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:["preload-images.js"]});
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:s=>{window.__ES_PDF_SETTINGS=s;},args:[settings]});
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:["printer.js"]});
    setTimeout(()=>{setStatus("PDF tab opened. Choose 'Save as PDF' in dialog.","ok");btnPdf.disabled=false;
      chrome.runtime.sendMessage({type:"recordHistory",url:tab.url,title:tab.title,format:"pdf"});},1000);
  }catch(e){console.error(e);setStatus("PDF export failed.","err");btnPdf.disabled=false;}
});

// ── Markdown ────────────────────────────────────────────────────────────────
btnMd.addEventListener("click",async()=>{
  try{
    const tab=await activeTab();
    const[r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
      const main=document.querySelector("article")||document.querySelector("[class*='article']")||document.querySelector("main")||document.body;
      function toMd(el){let md="";el.childNodes.forEach(n=>{if(n.nodeType===3){md+=n.textContent;return;}
        if(n.nodeType!==1)return;const t=n.tagName.toLowerCase();if(["script","style","noscript"].includes(t))return;
        if(/^h[1-6]$/.test(t)){md+="\n"+"#".repeat(+t[1])+" "+n.textContent.trim()+"\n\n";return;}
        if(t==="p"){md+=n.textContent.trim()+"\n\n";return;}if(t==="pre"||t==="code"){md+="\n```\n"+n.textContent+"\n```\n\n";return;}
        if(t==="a"){md+="["+n.textContent+"]("+n.href+")";return;}if(t==="img"){md+="!["+  (n.alt||"")+  "]("+n.src+")\n\n";return;}
        if(t==="li"){md+="- "+n.textContent.trim()+"\n";return;}if(t==="br"){md+="\n";return;}
        if(t==="strong"||t==="b"){md+="**"+n.textContent+"**";return;}if(t==="em"||t==="i"){md+="*"+n.textContent+"*";return;}
        md+=toMd(n);});return md;}
      return toMd(main).replace(/\n{3,}/g,"\n\n").trim();
    }});
    const md=r?.result||"";const blob=new Blob([md],{type:"text/markdown"});const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=(tab.title||"page")+".md";a.click();URL.revokeObjectURL(url);
    setStatus("Markdown downloaded.","ok");
  }catch(e){setStatus("Markdown export failed.","err");}
});

// ── HTML ────────────────────────────────────────────────────────────────────
btnHtml.addEventListener("click",async()=>{
  try{const tab=await activeTab();
    const[r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>"<!DOCTYPE html>\n"+document.documentElement.outerHTML});
    const blob=new Blob([r?.result||""],{type:"text/html"});const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=(tab.title||"page")+".html";a.click();URL.revokeObjectURL(url);
    setStatus("HTML downloaded.","ok");
  }catch(e){setStatus("HTML export failed.","err");}
});

// ── Clipboard ───────────────────────────────────────────────────────────────
btnClip.addEventListener("click",async()=>{
  try{const tab=await activeTab();
    const[r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
      const m=document.querySelector("article")||document.querySelector("[class*='article']")||document.querySelector("main")||document.body;return m.innerText;}});
    await navigator.clipboard.writeText(r?.result||"");setStatus("Text copied.","ok");
  }catch(e){setStatus("Copy failed.","err");}
});

// ── Batch Quick-Add ─────────────────────────────────────────────────────────
async function loadBatchList(){
  const{batches}=await chrome.storage.session.get("batches");
  const bs=batches||{};
  batchSelect.innerHTML='<option value="">-- select batch --</option>';
  Object.values(bs).forEach(b=>{
    const opt=document.createElement("option");opt.value=b.id;opt.textContent=b.name;batchSelect.appendChild(opt);
  });
}

$("btn-add-to-batch").addEventListener("click",async()=>{
  const bid=batchSelect.value;
  if(!bid){setStatus("Select a batch first.","err");return;}
  const tab=await activeTab();
  const{batches}=await chrome.storage.session.get("batches");
  if(!batches?.[bid])return;
  batches[bid].items.push({id:"i_"+Date.now(),url:tab.url,title:tab.title||tab.url,status:"queued",overrides:null,error:null});
  await chrome.storage.session.set({batches});
  setStatus(`Added to "${batches[bid].name}".`,"ok");
});

$("btn-new-batch-popup").addEventListener("click",async()=>{
  const name=$("new-batch-input").value.trim();
  if(!name){setStatus("Enter a batch name.","err");return;}
  const{batches}=await chrome.storage.session.get("batches");
  const bs=batches||{};
  const id="b_"+Date.now();
  bs[id]={id,name,created:Date.now(),items:[],settings:{pageSize:"A4",orientation:"portrait",marginCm:0.5},status:"idle"};
  await chrome.storage.session.set({batches:bs});
  $("new-batch-input").value="";
  loadBatchList();
  batchSelect.value=id;
  setStatus(`Batch "${name}" created.`,"ok");
});

// ── Footer links ────────────────────────────────────────────────────────────
$("link-settings").addEventListener("click",e=>{e.preventDefault();chrome.runtime.openOptionsPage();});
$("link-batches").addEventListener("click",e=>{e.preventDefault();chrome.tabs.create({url:chrome.runtime.getURL("options.html#/batches")});});
$("link-history").addEventListener("click",e=>{e.preventDefault();chrome.tabs.create({url:chrome.runtime.getURL("options.html#/history")});});
