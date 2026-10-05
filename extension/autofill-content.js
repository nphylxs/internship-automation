// Chrome content scripts use classic entry points; the engine is a local module.
(() => {
  if (globalThis.__internshipAutofill) return;
  const ready = import(chrome.runtime.getURL('autofill/engine.js')).then(({createAutofillEngine}) => {
    const engine = createAutofillEngine(); engine.start(); return engine;
  });
  globalThis.__internshipAutofill = ready;
  chrome.runtime.onMessage.addListener((message,sender,respond) => {
    if (sender.id !== chrome.runtime.id || !['autofill_apply','autofill_status','autofill_stop'].includes(message.action)) return false;
    ready.then(engine => message.action === 'autofill_apply' ? engine.apply(message.profile,message.context) : message.action === 'autofill_stop' ? engine.stop() : engine.status())
      .then(respond,error => respond({error:error.message}));
    return true;
  });
})();
