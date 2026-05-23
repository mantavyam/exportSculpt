"use strict";
importScripts("lib/jszip.min.js");

const DEFAULTS = {
  theme:"light", autoClean:false, scrollBehavior:true, historyEnabled:false,
  filenameTemplate:"{title} - {date}", headerFooterStamp:true,
  pdfDefaults:{pageSize:"A4",orientation:"portrait",marginCm:0.5},
  scalerPresets:{}, customSelectors:{}
};

async function getSettings(){
  const s=await chrome.storage.local.get(Object.keys(DEFAULTS));
  return{...DEFAULTS,...s};
}

// ── Context menus ───────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(()=>{
  chrome.contextMenus.create({id:"es-clean",title:"Clean this page",contexts:["page"]});
  chrome.contextMenus.create({id:"es-add-batch",title:"Add to batch\u2026",contexts:["page"]});
});

chrome.contextMenus.onClicked.addListener(async(info,tab)=>{
  if(info.menuItemId==="es-clean") await injectClean(tab.id,tab.url);
  else if(info.menuItemId==="es-add-batch"){
    const pending=(await chrome.storage.session.get("pendingBatchUrl")).pendingBatchUrl||[];
    pending.push({url:tab.url,title:tab.title});
    await chrome.storage.session.set({pendingBatchUrl:pending});
    chrome.tabs.create({url:chrome.runtime.getURL("options.html#/batches")});
  }
});

// ── Keyboard shortcuts ──────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async(cmd)=>{
  const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab)return;
  if(cmd==="clean-page") await injectClean(tab.id,tab.url);
  if(cmd==="export-pdf"){
    await injectClean(tab.id,tab.url);
    const s=await getSettings();
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:o=>{window.__ES_SCROLL_OPTS=o;},args:[{expandHorizontal:s.scrollBehavior}]});
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:["preload-images.js"]});
    await chrome.scripting.executeScript({target:{tabId:tab.id},func:o=>{window.__ES_PDF_SETTINGS=o;},args:[s.pdfDefaults]});
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:["printer.js"]});
  }
});

// ── Auto-clean ──────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async(tabId,changeInfo,tab)=>{
  if(changeInfo.status!=="complete"||!tab.url)return;
  const s=await getSettings();
  if(!s.autoClean)return;
  try{if(new URL(tab.url).hostname.includes("scaler.com")) await injectClean(tabId,tab.url);}catch(_){}
});

// ── Inject cleaner ──────────────────────────────────────────────────────────
async function injectClean(tabId,tabUrl){
  const s=await getSettings();
  const cleanOpts={scalerPresets:s.scalerPresets,removeHeader:false,removeFooter:false,customSelectors:[]};
  try{
    const host=new URL(tabUrl).hostname;
    if(s.customSelectors[host]?.enabled) cleanOpts.customSelectors=s.customSelectors[host].selectors||[];
  }catch(_){}
  await chrome.scripting.executeScript({target:{tabId},func:o=>{window.__ES_CLEAN_OPTS=o;},args:[cleanOpts]});
  await chrome.scripting.executeScript({target:{tabId},files:["cleaner.js"]});
}

// ── Message handler ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.type==="recordHistory"){
    (async()=>{
      const s=await getSettings();
      if(!s.historyEnabled)return;
      const{history}=await chrome.storage.local.get("history");
      const list=history||[];
      list.unshift({id:"h_"+Date.now(),url:msg.url,title:msg.title,format:msg.format,timestamp:Date.now()});
      if(list.length>500)list.length=500;
      await chrome.storage.local.set({history:list});
    })();
  }
  if(msg.type==="startBatch"){
    processBatch(msg.batchId).then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:e.message}));
    return true;
  }
  if(msg.type==="retryFailed"){
    retryFailed(msg.batchId).then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:e.message}));
    return true;
  }
  if(msg.type==="downloadZip"){
    downloadBatchZip(msg.batchId).then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:e.message}));
    return true;
  }
});

// ── Page sizes in inches ────────────────────────────────────────────────────
const SIZES={A4:{w:8.27,h:11.69},A3:{w:11.69,h:16.54},B5:{w:6.93,h:9.84},Letter:{w:8.5,h:11}};

function getFilename(template,item){
  const d=new Date();const date=d.toISOString().slice(0,10);
  const time=d.toTimeString().slice(0,5).replace(":","");
  let domain="";try{domain=new URL(item.url).hostname;}catch(_){}
  let title=(item.title||"page").replace(/[<>:"/\\|?*]/g,"_").slice(0,80);
  return(template||"{title} - {date}").replace("{title}",title).replace("{date}",date)
    .replace("{time}",time).replace("{domain}",domain)+".pdf";
}

// ── Wait for tab to fully load ──────────────────────────────────────────────
function waitForTab(tabId,timeout=35000){
  return new Promise((resolve)=>{
    let done=false;
    function finish(){if(!done){done=true;chrome.tabs.onUpdated.removeListener(listener);resolve();}}
    function listener(id,info){if(id===tabId&&info.status==="complete")finish();}
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish,timeout);
  });
}

// ── Dismiss exit-intent popups and other modals ─────────────────────────────
async function dismissPopups(tabId){
  try{
    await chrome.scripting.executeScript({target:{tabId},func:()=>{
      // Remove exit-intent modals
      document.querySelectorAll(".exit-intent_modal_container__O2C8_").forEach(el=>el.remove());
      // Also try generic modal/overlay patterns
      document.querySelectorAll("[class*='exit-intent'],[class*='modal_overlay'],[class*='popup_overlay']").forEach(el=>el.remove());
      // Remove any backdrop/overlay divs
      document.querySelectorAll(".ReactModal__Overlay,[class*='overlay'][class*='modal']").forEach(el=>el.remove());
    }});
  }catch(_){}
}

// ── Process a single batch item with retry ──────────────────────────────────
async function processItem(item, batchSettings, globalSettings, attempt){
  attempt = attempt || 1;
  let tab;
  try{
    tab = await chrome.tabs.create({url:item.url, active:false});
    await waitForTab(tab.id);
    // Extra settle time — prevents first-task failures
    await new Promise(r=>setTimeout(r, 2500));

    // Dismiss any popups that appeared
    await dismissPopups(tab.id);
    await new Promise(r=>setTimeout(r, 500));

    // Clean
    await injectClean(tab.id, item.url);
    await new Promise(r=>setTimeout(r, 500));

    // Dismiss popups again (may appear after clean)
    await dismissPopups(tab.id);

    // Preload images
    await chrome.scripting.executeScript({
      target:{tabId:tab.id}, func:o=>{window.__ES_SCROLL_OPTS=o;},
      args:[{expandHorizontal:globalSettings.scrollBehavior}]
    });
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:["preload-images.js"]});
    await new Promise(r=>setTimeout(r, 2500));

    // Dismiss popups one more time after scrolling
    await dismissPopups(tab.id);

    // Get title
    const[titleRes]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>document.title});
    item.title = titleRes?.result || item.title || "page";

    // ── Inject print CSS (min-width:0, color-adjust, code wrapping) ──────────
    const iSettings = item.overrides || batchSettings || globalSettings.pdfDefaults;
    const sz = SIZES[iSettings.pageSize] || SIZES.A4;
    const isLand = iSettings.orientation === "landscape";
    const marginCm = iSettings.marginCm || 0;
    const marginPx = marginCm * 37.795; // 1cm = 37.795 CSS px at 96 DPI
    const pageWidthPx = isLand ? sz.h * 96 : sz.w * 96; // inches → CSS px

    const batchPrintCSS = `
      *,*::before,*::after{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
      @media print {
        @page{size:${iSettings.pageSize} ${iSettings.orientation};margin:0!important;}
        html,body{margin:0!important;min-width:0!important;height:auto!important;overflow:visible!important;}
        *{min-width:0!important;overflow:visible!important;max-height:none!important;}
        [style*="position:fixed"],[style*="position: fixed"],[style*="position:sticky"],[style*="position: sticky"],.exit-intent_modal_container__O2C8_{display:none!important;}
        body>*,main,article,[class*="article"],[class*="content"],[class*="layout"],[class*="wrapper"],[class*="container"]{max-width:100%!important;box-sizing:border-box!important;}
        pre,pre[class],code[class],.code-box_snippetContainer__cJ6zK,[class*="code-box"],[class*="highlight"],[class*="snippet"]{
          page-break-inside:auto!important;break-inside:auto!important;overflow:visible!important;
          white-space:pre-wrap!important;word-break:break-word!important;overflow-wrap:break-word!important;max-width:100%!important;}
        pre>span,pre>div,pre li,pre .line,code>span,code>div,code .line,.code-box_snippetContainer__cJ6zK>*{
          page-break-inside:avoid!important;break-inside:avoid!important;white-space:pre-wrap!important;word-break:break-word!important;}
        table{page-break-inside:auto!important;break-inside:auto!important;width:100%!important;}
        thead{display:table-header-group;}ffoot{display:table-footer-group;}
        tr,td,th{page-break-inside:auto!important;break-inside:auto!important;}
        h1,h2,h3,h4,h5,h6{page-break-after:avoid!important;}
        a,a:visited{color:#1155cc!important;text-decoration:underline!important;}
        img{max-width:100%!important;height:auto!important;}
      }
    `;

    await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func:(css) => {
        let s = document.getElementById("__es_batch_print__");
        if (!s) { s = document.createElement("style"); s.id = "__es_batch_print__"; document.head.appendChild(s); }
        s.textContent = css;
        // Apply body padding and neutralise min-widths for accurate measurement
        document.documentElement.style.minWidth = "0";
        document.body.style.minWidth = "0";
        document.body.style.padding = "0";
        document.body.style.margin  = "0";
        void document.body.offsetHeight; // force reflow
      },
      args:[batchPrintCSS]
    });

    // ── Measure actual content width at current (screen) scale ───────────────
    const[widthRes]=await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func:() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    });
    const contentWidth = widthRes?.result || pageWidthPx;

    // Target width = page width minus margins
    const targetW = pageWidthPx - marginPx * 2;

    // Scale to fit: if content is wider than the target, shrink it.
    // Page.printToPDF scale is a multiplier applied to the page content.
    // content * scale = targetW  →  scale = targetW / content
    const pdfScale = contentWidth > targetW ? Math.max(0.25, targetW / contentWidth) : 1;

    // ── PDF via debugger ──────────────────────────────────────────────────────
    await chrome.debugger.attach({tabId:tab.id},"1.3");
    const result = await chrome.debugger.sendCommand({tabId:tab.id},"Page.printToPDF",{
      landscape:isLand,
      paperWidth: isLand ? sz.h : sz.w,
      paperHeight: isLand ? sz.w : sz.h,
      marginTop: marginCm / 2.54,   // cm → inches
      marginBottom: marginCm / 2.54,
      marginLeft: marginCm / 2.54,
      marginRight: marginCm / 2.54,
      printBackground:true,
      preferCSSPageSize:false,
      scale: pdfScale
    });
    await chrome.debugger.detach({tabId:tab.id});
    await chrome.tabs.remove(tab.id);

    return result.data;
  }catch(e){
    // Detach debugger if attached
    try{if(tab) await chrome.debugger.detach({tabId:tab.id});}catch(_){}
    try{if(tab) await chrome.tabs.remove(tab.id);}catch(_){}

    // Auto-retry once on first failure
    if(attempt < 2){
      await new Promise(r=>setTimeout(r, 1500));
      return processItem(item, batchSettings, globalSettings, attempt+1);
    }
    throw e;
  }
}

// ── Batch processor ─────────────────────────────────────────────────────────
async function processBatch(batchId){
  const{batches}=await chrome.storage.session.get("batches");
  if(!batches?.[batchId]) throw new Error("Batch not found");
  const batch=batches[batchId];
  batch.status="processing";
  // Store PDF data alongside batch
  if(!batch.pdfData) batch.pdfData={};
  await saveBatches(batches);

  const s=await getSettings();

  for(let i=0;i<batch.items.length;i++){
    const item=batch.items[i];
    if(item.status==="done") continue;
    item.status="processing"; item.error=null;
    await saveBatches(batches);
    notifyBatchUpdate(batchId);

    try{
      const pdfBase64 = await processItem(item, batch.settings, s, 1);
      batch.pdfData[item.id] = pdfBase64;
      item.status="done";
    }catch(e){
      item.status="failed"; item.error=e.message;
    }
    await saveBatches(batches);
    notifyBatchUpdate(batchId);
  }

  // Check results
  const doneCount = batch.items.filter(i=>i.status==="done").length;
  const failCount = batch.items.filter(i=>i.status==="failed").length;
  batch.status = failCount > 0 ? "partial" : "done";
  await saveBatches(batches);
  notifyBatchUpdate(batchId);

  // Auto-download zip if we have any completed PDFs
  if(doneCount > 0){
    await downloadBatchZip(batchId);
  }
}

// ── Download zip of completed PDFs ──────────────────────────────────────────
async function downloadBatchZip(batchId){
  const{batches}=await chrome.storage.session.get("batches");
  const batch=batches?.[batchId];
  if(!batch) return;

  const s=await getSettings();
  const zip = new JSZip();
  let count = 0;

  for(const item of batch.items){
    if(item.status==="done" && batch.pdfData?.[item.id]){
      const filename = getFilename(s.filenameTemplate, item);
      zip.file(filename, batch.pdfData[item.id], {base64:true});
      count++;
    }
  }

  if(count === 0) return;

  // Generate zip as base64 data URL (createObjectURL not available in service workers)
  const base64 = await zip.generateAsync({type:"base64"});
  const dataUrl = "data:application/zip;base64," + base64;

  await chrome.downloads.download({
    url: dataUrl,
    filename: (batch.name || "batch").replace(/[<>:"/\\|?*]/g,"_") + ".zip",
    saveAs: true
  });
}

async function retryFailed(batchId){
  const{batches}=await chrome.storage.session.get("batches");
  if(!batches?.[batchId])return;
  batches[batchId].items.forEach(it=>{if(it.status==="failed"){it.status="queued";it.error=null;}});
  batches[batchId].status="idle";
  await saveBatches(batches);
  await processBatch(batchId);
}

async function saveBatches(batches){await chrome.storage.session.set({batches});}
function notifyBatchUpdate(batchId){chrome.runtime.sendMessage({type:"batchUpdate",batchId}).catch(()=>{});}
