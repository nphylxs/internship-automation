import {$,request,notify,on} from './client.js';
import {element} from './ui.js';
import {parseCSV,guessMapping,sheetFields} from './sheets.js';
import {sheetOrigins} from './sheet-sync.js';
export function initConnections() {
  let preview=null,csv;
  function mapping() {
    $('sheet-mapping').replaceChildren();
    if(!preview)return;
    $('sheet-mapping').append(element('p','small muted',`${preview.count} rows found. Table starts on row ${preview.headerRow || 1}.`));
    for(const [field,names] of Object.entries(sheetFields)) {
      const label=element('label','sheet-field',names[0]),select=element('select');select.dataset.field=field;select.add(new Option('Not mapped','-1'));
      preview.headers.forEach((name,index)=>select.add(new Option(name || `Column ${index+1}`,String(index))));select.value=String(preview.mapping[field] ?? -1);label.append(select);$('sheet-mapping').append(label);
    }
    const sample=element('details');sample.append(element('summary','','Preview first five rows'));preview.sample.forEach(row=>sample.append(element('p','small',row.join(' · '))));$('sheet-mapping').append(sample);
    $('sheet-connect').hidden=false;$('sheet-connect').textContent=csv===undefined?'Connect & sync':'Import mapped CSV';
  }
  on('sheet-preview',async()=>{if(!await chrome.permissions.request({origins:sheetOrigins}))throw new Error('Sheets access was declined. You can import a CSV instead.');csv=undefined;preview=await request({action:'sheet_preview',url:$('sheet-url').value});mapping();});
  $('sheet-csv').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>2000000)throw new Error('Use a CSV smaller than 2 MB.');csv=await file.text();const table=parseCSV(csv);preview={...table,mapping:guessMapping(table.headers),sample:table.rows.slice(0,5),count:table.rows.length};mapping();}catch(error){notify(error.message,true);}};
  on('sheet-connect',async()=>{if(!preview)throw new Error('Preview a Sheet or CSV first.');const mapping=Object.fromEntries([...$('sheet-mapping').querySelectorAll('select')].map(input=>[input.dataset.field,Number(input.value)]));await request({action:csv===undefined?'sheet_connect':'sheet_import',csv,config:{url:$('sheet-url').value,autoSync:$('sheet-auto').checked,headers:preview.headers,mapping}});notify('Updates imported. Matched updates appear in application timelines.');await refresh();});
  on('sheet-sync',async()=>{await request({action:'sheet_sync'});notify('Updates refreshed.');});
  on('sheet-disconnect',async()=>{await request({action:'sheet_disconnect'});notify('Disconnected. Previous updates remain in application history.');});
  async function refresh(){const {sheetTracker}=await chrome.storage.local.get('sheetTracker');$('sheet-status').textContent=sheetTracker?.error || (sheetTracker?.lastSync?`Last sync: ${new Date(sheetTracker.lastSync).toLocaleString()}. ${Object.keys(sheetTracker.records || {}).length} tracked applications.`:'Optional, read-only import. Sheets updates will appear beside your saved applications.');if(!preview && sheetTracker?.source?.url)$('sheet-url').value=sheetTracker.source.url;}
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && changes.sheetTracker)void refresh();});void refresh();
}
