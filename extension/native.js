// The background worker owns generation ports, so closing the workspace is safe.
export function nativeRequest(request) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative('com.internship.desk');
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); port.disconnect();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Operation timed out. Retry this job from the queue.')), 650000);
    port.onMessage.addListener(message => finish(message.error ? new Error(message.error) : null, message));
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      finish(new Error(`Local helper unavailable: ${error?.message || 'connection closed'}`));
    });
    try { port.postMessage(request); } catch (error) { finish(error); }
  });
}
