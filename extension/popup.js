const $ = id => document.getElementById(id);
let candidates = [];
const activeTabs = chrome.tabs.query({active: true, currentWindow: true});
const settingsReady = chrome.storage.local.get('captureSettings').then(({captureSettings}) => {
  $('prepare-on-save').checked = captureSettings?.prepare !== false;
  $('capture-template').value = captureSettings?.template || 'fpga';
  updateLabel();
});
const captureOptions = () => ({prepare: $('prepare-on-save').checked, template: $('capture-template').value});
function updateLabel() { $('save-current').textContent = $('prepare-on-save').checked ? 'Save & prepare this listing' : 'Save this listing'; }
for (const id of ['prepare-on-save', 'capture-template']) $(id).onchange = () => {
  updateLabel(); chrome.storage.local.set({captureSettings: captureOptions()}).catch(error => notice(error.message, true));
};
function notice(text, error = false) { $('popup-notice').textContent = text; $('popup-notice').className = error ? 'error' : ''; }
chrome.storage.local.get('lastCapture').then(({lastCapture}) => {
  const errors = (lastCapture?.results || []).filter(r => r.error || r.preparationError);
  if (errors.length) notice('Last capture needs attention:\n' + errors.map(r => `${r.title || 'Listing'}: ${r.error || r.preparationError}`).join('\n'), true);
}).catch(error => notice(error.message, true));
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw new Error(result.error);
  return result;
}
async function capture(ids) {
  $('save-current').disabled = $('save-selected').disabled = true;
  notice('Saving listings…');
  try {
    await settingsReady;
    const {results} = await send({action: 'capture_tabs', tabIds: ids, options: captureOptions()});
    const errors = results.filter(r => r.error);
    const prepareErrors = results.filter(r => r.preparationError);
    notice(`${results.length - errors.length} listing(s) saved. ${results.filter(r => r.preparation === 'queued').length} application(s) queued.${results.some(r => r.preparation === 'existing') ? ' Existing drafts or queue entries kept.' : ''}${errors.length ? '\n' + errors.map(r => `Tab ${r.tabId}: ${r.error}`).join('\n') : ''}${prepareErrors.length ? '\nSaved, but preparation needs attention:\n' + prepareErrors.map(r => `${r.title}: ${r.preparationError}`).join('\n') : ''}`, Boolean(errors.length || prepareErrors.length));
  } finally { $('save-current').disabled = $('save-selected').disabled = false; }
}
$('save-current').onclick = async () => {
  try { const [tab] = await activeTabs; if (!tab) throw new Error('No active tab.'); await capture([tab.id]); }
  catch (error) { notice(error.message, true); }
};
$('choose-tabs').onclick = async () => {
  try {
    if (!await chrome.permissions.request({permissions: ['tabs']})) throw new Error('Tab access was declined. You can still save each active listing.');
    candidates = (await chrome.tabs.query({currentWindow: true})).filter(tab => /^https?:\/\//.test(tab.url || ''));
    $('tabs').replaceChildren();
    for (const tab of candidates) {
      const label = document.createElement('label'); const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.value = tab.id; checkbox.checked = tab.highlighted;
      label.append(checkbox, document.createTextNode(tab.title || tab.url)); $('tabs').append(label);
    }
    $('batch').hidden = false; notice(candidates.length ? 'Choose the job tabs to save.' : 'No web pages in this window.');
  } catch (error) { notice(error.message, true); }
};
$('save-selected').onclick = async () => {
  try {
    const ids = [...$('tabs').querySelectorAll('input:checked')].map(input => Number(input.value));
    if (!ids.length) throw new Error('Select at least one job tab.');
    const origins = [...new Set(candidates.filter(tab => ids.includes(tab.id)).map(tab => new URL(tab.url).origin + '/*'))];
    if (!await chrome.permissions.request({origins})) throw new Error('Site access was declined. You can still save each active listing.');
    await capture(ids);
  } catch (error) { notice(error.message, true); }
};
$('workspace').onclick = () => send({action: 'open_workspace'}).catch(error => notice(error.message, true));
$('collect-start').onclick = async () => {
  $('collect-start').disabled = true;
  try {
    await settingsReady;
    const [tab] = await activeTabs;
    if (!tab?.id) throw new Error('No active job tab.');
    await send({action: 'collect_start', tabId: tab.id, options: {...captureOptions(), limit: Number($('collect-limit').value)}});
    notice('Collection started. You can close this popup. Reopen it to check progress or stop.');
  } catch (error) { notice(error.message, true); }
  finally { await renderProgress(); }
};
$('collect-stop').onclick = () => send({action: 'collect_stop'}).catch(error => notice(error.message, true));
async function renderProgress() {
  const {collection, generationQueue = [], queueSettings} = await chrome.storage.local.get(['collection', 'generationQueue', 'queueSettings']);
  const running = collection?.state === 'running';
  $('collect-start').hidden = running;
  $('collect-start').disabled = running;
  $('collect-stop').hidden = !running;
  const failures = collection?.results.filter(r => r.preparationError) || [];
  $('collection-status').textContent = collection ? `${collection.results.length} listing(s) saved · ${collection.state}. ${collection.message}${failures.length ? '\nPreparation needs attention: ' + [...new Set(failures.map(r => r.preparationError))].join('\n') : ''}` : '';
  const failed = generationQueue.filter(q => ['failed', 'interrupted'].includes(q.state));
  $('popup-ready-count').textContent = generationQueue.filter(q => q.state === 'completed').length;
  $('popup-working-count').textContent = generationQueue.filter(q => ['pending', 'running', 'saving'].includes(q.state)).length;
  const alerts = [queueSettings?.paused ? 'Queue paused. Resume preparation in Applications.' : '', failed.length ? `${failed.length} need attention: ${failed.at(-1).error} Open Applications to retry.` : ''].filter(Boolean);
  $('preparation-alert').textContent = alerts.join('\n');
  $('preparation-alert').hidden = !alerts.length;
  $('preparation-status').textContent = `${generationQueue.filter(q => ['pending', 'running', 'saving'].includes(q.state)).length} applications preparing · ${generationQueue.filter(q => q.state === 'completed').length} ready.${queueSettings?.paused ? ' Queue is paused — resume it in Applications.' : ''}${failed.length ? '\n' + failed.length + ' need attention: ' + failed.at(-1).error + ' Open Applications to retry.' : ''}`;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['collection', 'generationQueue', 'queueSettings'].some(key => key in changes)) void renderProgress().catch(error => notice(error.message, true));
});
void renderProgress().catch(error => notice(error.message, true));
