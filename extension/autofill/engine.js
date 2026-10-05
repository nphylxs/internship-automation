import {matchField, valueFor, matchingOption} from './profile.js';

const helperStyle = `:host{display:block!important;margin:7px 0 12px!important;font:12px/1.5 system-ui,sans-serif!important;color:#243247!important;text-align:left!important}*{box-sizing:border-box}button{font:600 12px/1.4 system-ui,sans-serif;border:1px solid #cbd5e1;border-radius:7px;background:#f8fafc;color:#243247;padding:7px 10px;cursor:pointer;margin-right:6px}button:hover{background:#e2e8f0}button:disabled{opacity:.6;cursor:wait}button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}.preview{max-width:640px;margin:8px 0;padding:12px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px}.answer{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}p{margin:6px 0}.note{color:#64748b}.error{color:#9f1239}`;

function visible(field) {
  const style = getComputedStyle(field), rect = field.getBoundingClientRect();
  return !field.closest('[hidden],[inert],[aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden' && style.clipPath !== 'inset(50%)' && rect.right >= 0 && rect.width > 2 && rect.height > 2 && field.getClientRects().length > 0;
}
function labelFor(field) {
  const labelled = (field.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
  const labels = [...(field.labels || [])].map(label => {
    const copy = label.cloneNode(true); copy.querySelectorAll('input,textarea,select,button,[data-desk-helper]').forEach(el => el.remove()); return copy.textContent;
  }).join(' ').trim();
  return (labelled || field.getAttribute('aria-label') || labels || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}
function description(field) {
  const fieldset = field.closest('fieldset');
  const section = field.closest('[data-automation-id*="Section"], [role="group"]');
  return {
    label: labelFor(field),
    hints: [field.name, field.id, field.placeholder, field.getAttribute('data-automation-id')].filter(Boolean),
    autocomplete: field.autocomplete || '',
    context: [fieldset?.querySelector('legend')?.textContent, section?.getAttribute('aria-label'), section?.getAttribute('data-automation-id')].filter(Boolean).join(' ')
  };
}
function nativeValue(field, value) {
  const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
  field.dispatchEvent(new Event('change', {bubbles: true, composed: true}));
}
function eligible(field) {
  return !field.disabled && !field.readOnly && visible(field) && !field.closest('[data-desk-helper]') &&
    !['hidden','password','button','submit','reset','image','search'].includes(field.type) &&
    !/captcha|password|username|\btoken\b/i.test([field.name, field.id, field.autocomplete].join(' ')) &&
    !field.closest('form')?.querySelector('input[type=password]');
}

export function createAutofillEngine({send = message => chrome.runtime.sendMessage(message), root = document} = {}) {
  let active = false, profile = {}, context = {}, timer, observer, lastUrl = location.href, epoch = 0;
  const helpers = new Map(), marked = new Set(), touched = new WeakSet();
  const totals = {filled:0, manual:0, preserved:0};
  function mark(field, state) { field.setAttribute('data-internship-autofill', state); marked.add(field); }
  function clear(field) { field.removeAttribute('data-internship-autofill'); marked.delete(field); }
  function helper(field, kind) {
    if (helpers.has(field)) return;
    const host = document.createElement('span'); host.dataset.deskHelper = kind;
    const shadow = host.attachShadow({mode:'open'}), style = document.createElement('style'); style.textContent = helperStyle; shadow.append(style);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = kind === 'answer' ? 'Generate answer' : 'Download selected resume';
    const status = document.createElement('p'); status.setAttribute('role','status'); status.className = 'note'; shadow.append(button,status);
    field.insertAdjacentElement('afterend', host); helpers.set(field, {host,shadow});
    button.onclick = async event => {
      if (!event.isTrusted) return;
      if (!active) { status.textContent = 'Choose an application in Internship Desk, then click Fill this page.'; return; }
      button.disabled = true; status.className = 'note';
      const before = field.value, pageUrl = location.href, startedEpoch = epoch;
      try {
        if (kind === 'resume') {
          status.textContent = 'Preparing selected PDF…';
          const result = await send({action:'autofill_resume'});
          if (result.error) throw new Error(result.error);
          const blob = new Blob([Uint8Array.from(atob(result.pdf_base64), c => c.charCodeAt(0))], {type:'application/pdf'});
          const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = result.filename; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
          status.textContent = 'Downloaded. Choose this file with the employer’s upload control.';
          return;
        }
        const question = labelFor(field) || field.placeholder || '';
        if (!question.trim()) throw new Error('This field has no question label. Enter its answer manually.');
        status.textContent = 'Drafting from your saved job description and verified profile…';
        const result = await send({action:'autofill_answer', question, maxLength: field.maxLength > 0 ? Math.min(field.maxLength,4000) : 2000});
        if (result.error) throw new Error(result.error);
        if (!active || startedEpoch!==epoch || !field.isConnected || location.href !== pageUrl) return;
        shadow.querySelector('.preview')?.remove();
        const preview = document.createElement('div'); preview.className = 'preview';
        const answer = document.createElement('p'); answer.className = 'answer'; answer.textContent = result.answer; preview.append(answer);
        const notes = document.createElement('p'); notes.className = 'note'; notes.textContent = (result.review_notes || []).join(' '); preview.append(notes);
        const insert = document.createElement('button'); insert.type = 'button'; insert.textContent = 'Use this answer'; insert.disabled = !result.answer;
        insert.onclick = click => {
          if (!click.isTrusted || !active || startedEpoch!==epoch || location.href!==pageUrl) return;
          if (field.value !== before) { status.textContent = 'Your text changed while drafting. It has been preserved; copy any wording you want from this preview.'; return; }
          nativeValue(field, result.answer); clear(field); status.textContent = 'Draft inserted. Review it before submitting your application.'; preview.remove();
        };
        const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss'; dismiss.onclick = () => preview.remove(); preview.append(insert,dismiss); shadow.append(preview);
        status.textContent = 'Review the draft below. Nothing has been inserted yet.';
      } catch (error) { status.className = 'error'; status.textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  function scan(fill = false) {
    if (location.href !== lastUrl) { lastUrl = location.href; active = false; profile = {}; epoch++; for(const field of marked)clear(field); }
    for (const [field, item] of helpers) if (!field.isConnected || !item.host.isConnected) { item.host.remove(); helpers.delete(field); }
    const result = {filled:0, manual:0, preserved:0};
    for (const field of root.querySelectorAll('input,select,textarea,[role=combobox]')) {
      if (!eligible(field)) { if (marked.has(field)) clear(field); continue; }
      const meta = description(field);
      let current = ['checkbox','radio','file'].includes(field.type) ? '' : String(field.value || '').trim();
      if (field instanceof HTMLSelectElement && (field.selectedOptions[0]?.disabled || /^(select|choose|please select)\b/i.test(field.selectedOptions[0]?.text || ''))) current = '';
      if (field instanceof HTMLTextAreaElement) helper(field,'answer');
      if (field.type === 'file' && /\b(resume|cv|curriculum vitae)\b/i.test([meta.label,...meta.hints].join(' '))) helper(field,'resume');
      if (!active) continue;
      if (current || field.checked || field.files?.length) { result.preserved++; clear(field); continue; }
      if (touched.has(field)) { mark(field,'manual');result.manual++;continue; }
      if (field instanceof HTMLTextAreaElement || ['checkbox','radio','file','date'].includes(field.type) || field.getAttribute('role') === 'combobox') {
        // Custom dropdowns, eligibility, consent and essays need explicit review.
        mark(field,'manual'); result.manual++; continue;
      }
      const key = matchField(meta), desired = key && valueFor(key, profile);
      const value = field instanceof HTMLSelectElement && desired ? matchingOption([...field.options],desired) : desired;
      if (fill && value && (!field.maxLength || field.maxLength < 0 || value.length <= field.maxLength)) {
        nativeValue(field,value);
        if (field.value === value) { result.filled++; clear(field); continue; }
      }
      mark(field,'manual'); result.manual++;
    }
    totals.filled += result.filled; totals.manual = result.manual; totals.preserved = result.preserved;
    return {...totals, active, application: context.title || ''};
  }
  function changed(event) {
    if (!event.target.matches('input,select,textarea,[role=combobox]')) return;
    if (event.isTrusted) touched.add(event.target);
    if (event.target.value || event.target.checked) clear(event.target);
  }
  function start() {
    scan(); root.addEventListener('input',changed); root.addEventListener('change',changed);
    observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => scan(active),200); });
    observer.observe(root.documentElement || root,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','disabled','aria-hidden','aria-expanded']});
  }
  return {
    start,
    apply(nextProfile,nextContext) { epoch++;for(const item of helpers.values())item.shadow.querySelector('.preview')?.remove();profile = nextProfile; context = nextContext; lastUrl = location.href; active = true; totals.filled = 0; return scan(true); },
    status: () => scan(false),
    stop() { epoch++;active = false; profile = {}; for (const field of marked) clear(field); for(const item of helpers.values())item.shadow.querySelector('.preview')?.remove();return {active:false}; },
    destroy() { active = false; profile = {}; observer?.disconnect(); clearTimeout(timer); for(const field of marked)clear(field); for(const {host} of helpers.values())host.remove(); helpers.clear(); root.removeEventListener('input',changed); root.removeEventListener('change',changed); }
  };
}
