import {nativeRequest} from './native.js';
import {defaultGeneration, progressLabels} from './generation.js';
export const $ = id => document.getElementById(id);
export function notify(text, error = false) { $('notice').textContent = text; $('notice').className = `notice${error ? ' error' : ''}`; }
export async function request(message) { const result = await chrome.runtime.sendMessage(message); if (result.error) throw new Error(result.error); return result; }
export async function native(message) {
  if (['generate','generate_letter','suggest_projects'].includes(message.action)) message = {...message, generation: (await chrome.storage.local.get('generationSettings')).generationSettings || defaultGeneration};
  return nativeRequest(message, event => notify(progressLabels[event.stage] || 'Preparing documents…'));
}
export function on(id, fn) {
  let pending = false;
  $(id).addEventListener('click', async () => {
    if (pending) return;
    const button = $(id); pending = true; button.setAttribute('aria-busy', 'true');
    try { await fn(); } catch(error) { notify(error.message, true); }
    finally { pending = false; button.removeAttribute('aria-busy'); }
  });
}
export function download(text, name, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function downloadPdf(base64, name) { download(Uint8Array.from(atob(base64), c => c.charCodeAt(0)), name, 'application/pdf'); }
