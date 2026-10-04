(async () => {
  const id = new URL(location.href).searchParams.get('id');
  const documentData = (await chrome.storage.session.get(id))[id];
  document.getElementById('document').textContent = documentData?.text || 'Document not found. Open the print preview from your application again.';
  document.title = documentData?.title || 'Application document';
  document.getElementById('print').onclick = () => window.print();
})();
