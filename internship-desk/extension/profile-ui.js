import {$,native,notify,on} from './client.js';
import {element} from './ui.js';
import {generationPresets,defaultGeneration} from './generation.js';
export async function initProfile() {
  let library=[];
  const stored=(await chrome.storage.local.get('profile')).profile || {};
  for(const field of ['facts','skills','constraints','answers'])$(field).value=stored[field] || '';
  library=structuredClone(stored.library || []);
  function render() {
    $('experience-library').replaceChildren();
    const all=element('label','check');const confirm=document.createElement('input');confirm.type='checkbox';confirm.checked=library.length>0 && library.every(item=>item.verified);
    all.append(confirm,document.createTextNode('I have reviewed all experience records below'));
    confirm.onchange=()=>{library.forEach(item=>item.verified=confirm.checked);render();};$('experience-library').append(all);
    library.forEach((item,index)=>{
      const details=element('details','experience');details.open=!item.heading[0];
      const summary=element('summary','',item.heading[0] || 'New experience');details.append(summary);
      const kind=element('label','','Type');const select=element('select');for(const [value,text] of [['education','Education'],['experience','Experience'],['projects','Project']])select.add(new Option(text,value,false,value===item.kind));kind.append(select);details.append(kind);
      const fields=element('div','pair');
      const changed=()=>{item.verified=false;check.checked=false;confirm.checked=false;};
      ['Institution / organization / project','Date or location (right column)','Degree / role / subtitle','Date or location (second row)'].forEach((title,i)=>{const label=element('label','',title),input=element('input');input.maxLength=300;input.value=item.heading[i] || '';input.oninput=()=>{item.heading[i]=input.value;if(i===0)summary.textContent=input.value || 'New experience';changed();};label.append(input);fields.append(label);});details.append(fields);
      select.onchange=()=>{item.kind=select.value;changed();};
      const facts=element('label','','Verified facts — one per line'),input=element('textarea');input.rows=5;input.value=item.bullets.join('\n');input.oninput=()=>{item.bullets=input.value.split('\n').map(v=>v.trim()).filter(Boolean);changed();};facts.append(input);details.append(facts);
      const tags=element('div','tag-options');for(const focus of ['fpga','robotics','power']){const label=element('label','check'),input=element('input');input.type='checkbox';input.checked=item.tags.includes(focus);input.onchange=()=>{item.tags=input.checked?[...item.tags,focus]:item.tags.filter(t=>t!==focus);};label.append(input,document.createTextNode(focus.toUpperCase()));tags.append(label);}details.append(tags);
      const review=element('label','check'),check=element('input');check.type='checkbox';check.checked=item.verified;check.onchange=()=>{item.verified=check.checked;confirm.checked=library.every(i=>i.verified);};review.append(check,document.createTextNode('Reviewed and accurate'));details.append(review);
      const remove=element('button','text-button','Remove experience');remove.onclick=()=>{library.splice(index,1);render();};details.append(remove);$('experience-library').append(details);
    });
  }
  render();
  on('import-library',async()=>{if(library.length && !confirm('Replace the experience library editor with the bundled resume sources? Saved data stays unchanged until you save.'))return;const result=await native({action:'import_library'});library=result.library;$('skills').value=result.skills;render();notify('Sources imported. Review facts, dates, and overlapping projects, then save.');});
  on('add-experience',()=>{library.push({id:crypto.randomUUID(),kind:'experience',heading:['','','',''],bullets:[''],tags:[],verified:false});render();});
  on('save-profile',async()=>{
    if(library.length && !library.every(item=>item.verified && item.heading[0].trim() && item.bullets.length && item.bullets.every(b=>b.length<=700)))throw new Error('Review all records and provide a title and factual bullets before saving.');
    if(library.length && ['education','experience','projects'].some(kind=>!library.some(item=>item.kind===kind)))throw new Error('Add at least one Education, Experience, and Project record for these resume templates.');
    const notes=$('facts').value.trim();
    const facts=notes || (library.length ? 'Verified experience is provided in the structured library. Use only those facts, skills, and the saved availability notes when preparing application documents.' : '');
    if(facts.length<100 && !library.length)throw new Error('Add at least 100 characters of verified facts or import your experience library.');
    const profile={facts,skills:$('skills').value.trim(),constraints:$('constraints').value.trim(),answers:$('answers').value.trim(),library:structuredClone(library)};
    await chrome.storage.local.set({profile});$('profile-status').textContent='Reviewed profile saved. Existing applications keep their original profile snapshots.';notify('Profile saved.');
  });
  const configured=(await chrome.storage.local.get('generationSettings')).generationSettings || defaultGeneration;
  $('generation-speed').value=Object.keys(generationPresets).find(key=>generationPresets[key].model===configured.model && generationPresets[key].effort===configured.effort) || 'fast';
  on('save-generation-settings',async()=>{await chrome.storage.local.set({generationSettings:generationPresets[$('generation-speed').value]});notify('Generation setting saved for new requests.');});
  on('connection',async()=>notify((await native({action:'health'})).message));
  on('save-export-settings',async()=>{const result=await native({action:'configure_exports',directory:$('export-directory').value,enabled:false});$('folder-status').textContent=`Approved packets will save to ${result.directory}`;});
  try{const result=await native({action:'export_settings'});$('export-directory').value=result.directory;}catch(error){$('folder-status').textContent=`Connect the local helper to save packets. ${error.message}`;}
}
