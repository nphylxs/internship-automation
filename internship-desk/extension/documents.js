// Keep PDF bytes out of the frequently rewritten jobs/queue metadata.
// Content-addressed keys also share unchanged PDFs across edited versions.
export async function storePdf(storage, version) {
  if (!version.pdf_base64) return version;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version.pdf_base64));
  const key = 'pdf:' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  if (!(await storage.get([key]))[key]) await storage.set({[key]: version.pdf_base64});
  const {pdf_base64, ...metadata} = version;
  return {...metadata, pdf_key: key};
}
export async function loadPdf(storage, version) {
  if (!version || version.pdf_base64 || !/^pdf:[a-f0-9]{64}$/.test(version.pdf_key || '')) return version;
  return {...version, pdf_base64: (await storage.get([version.pdf_key]))[version.pdf_key] || ''};
}
export async function migratePdfs(storage) {
  const {jobs = {}} = await storage.get(['jobs']);
  let changed = false;
  for (const record of Object.values(jobs)) {
    if (record.workingDraft?.pdf_base64) { record.workingDraft = await storePdf(storage, record.workingDraft); changed = true; }
    for (let index = 0; index < record.versions.length; index++) {
      if (!record.versions[index].pdf_base64) continue;
      record.versions[index] = await storePdf(storage, record.versions[index]); changed = true;
    }
  }
  // Write bytes first: interruption leaves the original inline version recoverable.
  if (changed) await storage.set({jobs});
}
export async function portableBackup(storage) {
  const data = await storage.get(null);
  for (const record of Object.values(data.jobs || {})) {
    if (record.workingDraft?.pdf_key) { record.workingDraft.pdf_base64 = data[record.workingDraft.pdf_key] || ''; delete record.workingDraft.pdf_key; }
    for (let index = 0; index < record.versions.length; index++) {
      const version = record.versions[index];
      if (version.pdf_key && data[version.pdf_key]) version.pdf_base64 = data[version.pdf_key];
      delete version.pdf_key;
    }
  }
  for (const key of Object.keys(data)) if (key.startsWith('pdf:')) delete data[key];
  return {format: 1, ...data};
}
