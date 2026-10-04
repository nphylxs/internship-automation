// Own one object URL per mounted preview and revoke it whenever the draft changes.
export function createPdfPreview({frame, empty, note}) {
  let objectUrl = null, previous = null;
  function clear() {
    frame.removeAttribute('src'); frame.hidden = true; empty.hidden = false;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null; previous = null; note.hidden = true;
  }
  function show(version) {
    if (!version?.pdf_base64) { clear(); return; }
    if (previous === version.pdf_base64) return;
    clear();
    try {
      const bytes = Uint8Array.from(atob(version.pdf_base64), c => c.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
      previous = version.pdf_base64;
      frame.src = objectUrl + '#toolbar=0&navpanes=0&view=FitH';
      frame.hidden = false; empty.hidden = true;
    } catch { note.textContent = 'This saved PDF could not be opened. Refresh the preview to compile it again.'; note.hidden = false; }
  }
  function dirty(changed) {
    note.textContent = 'The source has unsaved changes. Refresh the preview to see the updated PDF.';
    note.hidden = !changed;
  }
  return {show, clear, dirty};
}
