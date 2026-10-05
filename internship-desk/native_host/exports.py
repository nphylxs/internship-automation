"""Local PDF exports. Destination comes only from separately saved user settings."""
from __future__ import annotations
import base64
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unicodedata
import uuid

ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PATH = ROOT / 'data' / 'extension-export-settings.json'


def settings():
    defaults = {'enabled': False, 'directory': str(Path.home() / 'Downloads' / 'Internship Applications')}
    if SETTINGS_PATH.exists():
        defaults.update(json.loads(SETTINGS_PATH.read_text()))
    return defaults


def configure(request):
    directory = request.get('directory')
    if not isinstance(directory, str) or not directory.strip() or len(directory) > 4000:
        raise ValueError('Enter the full destination folder path')
    path = Path(directory.strip()).expanduser()
    if not path.is_absolute():
        raise ValueError('Use an absolute folder path, such as ~/Downloads/Internship Applications')
    if not isinstance(request.get('enabled'), bool):
        raise ValueError('Invalid automatic save setting')
    path.mkdir(parents=True, exist_ok=True)
    # Prove the selected folder is writable before remembering it.
    with tempfile.TemporaryFile(dir=path):
        pass
    result = {'enabled': request['enabled'], 'directory': str(path.resolve())}
    from native_host.runtime import write_text
    write_text(SETTINGS_PATH, json.dumps(result))
    return result


def filename_part(value, fallback, limit=40):
    value = unicodedata.normalize('NFKD', str(value or '')).encode('ascii', 'ignore').decode()
    value = re.sub(r'[^A-Za-z0-9-]+', '_', value).strip('_-')[:limit].rstrip('_-')
    if value.upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(10)), *(f'LPT{i}' for i in range(10))}:
        value = '_' + value
    return value or fallback


def letter_pdf(letter):
    if not isinstance(letter, str) or not 100 <= len(letter.strip()) <= 30000:
        raise ValueError('The cover letter is missing or too long to export')
    from native_host.host import tex_escape
    from native_host.runtime import compile_resume, GenerationError
    compiler = shutil.which('pdflatex')
    if not compiler:
        raise ValueError('pdflatex is required to save the cover letter PDF')
    paragraphs = [(r'\\' + '\n').join(tex_escape(line) for line in p.splitlines()) for p in re.split(r'\n\s*\n', letter.strip())]
    source = (r'\documentclass[letterpaper,11pt]{article}' + '\n' +
              r'\usepackage[margin=0.85in]{geometry}' + '\n' +
              r'\usepackage[T1]{fontenc}\usepackage[utf8]{inputenc}' + '\n' +
              r'\pagestyle{empty}\setlength{\parindent}{0pt}\setlength{\parskip}{10pt}' + '\n' +
              r'\begin{document}\raggedright' + '\n' + '\n\n'.join(paragraphs) + '\n' + r'\end{document}')
    with tempfile.TemporaryDirectory(prefix='internship-letter-') as folder:
        try:
            return compile_resume(Path(folder), source, compiler, 60).read_bytes()
        except GenerationError as exc:
            raise ValueError('Cover letter PDF failed to compile. Check the letter for unsupported characters, then retry saving.') from exc


def export_documents(request):
    config = settings()
    if not config['enabled'] and request.get('force') is not True:
        return {'skipped': True}
    encoded = request.get('pdf_base64', '')
    if not isinstance(encoded, str) or len(encoded) > 650000:
        raise ValueError('Invalid resume PDF')
    try:
        resume = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise ValueError('Invalid resume PDF encoding') from exc
    if not resume.startswith(b'%PDF-') or len(resume) < 100:
        raise ValueError('Generate a template PDF before saving to your folder')
    job = request.get('job')
    if not isinstance(job, dict):
        raise ValueError('Missing application details')
    # Compile everything before writing either final file.
    letter = letter_pdf(request['letter']) if request.get('letter', '').strip() else None
    from native_host.host import baseline_for
    _, baseline = baseline_for(request)
    header = baseline.split(r'\begin{center}', 1)[-1].split(r'\end{center}', 1)[0]
    # The header uses a literal TeX backslash, not a regular-expression escape.
    match = re.search(r'\\scshape\s+([^}]+)', header)
    applicant = filename_part(match[1] if match else '', 'Applicant')
    company = filename_part(job.get('company'), 'Unknown_Company', 32)
    role = filename_part(job.get('title'), 'Internship', 40)
    root = Path(config['directory']).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    destination = root / company
    if destination.is_symlink():
        raise ValueError('The company folder is a symbolic link. Choose another destination.')
    destination.mkdir(mode=0o700, exist_ok=True)
    if not destination.resolve().is_relative_to(root):
        raise ValueError('Export folder escapes the selected destination')
    version = datetime.now().strftime('%Y-%m-%d_%H%M%S') + '_' + uuid.uuid4().hex[:8]
    stem = f'{applicant}_{company}_{role}'
    paths = [destination / f'{stem}_{kind}_{version}.pdf' for kind in ('Resume', 'Cover_Letter')]
    written = []
    try:
        for path, content in zip(paths, (resume, letter)):
            if content is None: continue
            with path.open('xb') as output:
                written.append(path)
                os.chmod(path, 0o600)
                output.write(content)
    except OSError:
        for path in written:
            path.unlink(missing_ok=True)
        raise
    return {'directory': str(destination), 'resume_path': str(paths[0]), 'letter_path': str(paths[1]) if letter else ''}


def export_packet(request):
    """Publish one immutable, approved version; repeated exports reuse its files."""
    application_id, version_id = request.get('application_id', ''), request.get('version_id', '')
    if not all(isinstance(v, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', v) for v in (application_id, version_id)):
        raise ValueError('The approved packet needs valid application and version IDs')
    if request.get('approved') is not True: raise ValueError('Approve the documents before exporting a packet')
    encoded = request.get('pdf_base64', '')
    if not isinstance(encoded, str) or len(encoded) > 650000: raise ValueError('Invalid resume PDF')
    try: resume = base64.b64decode(encoded, validate=True)
    except ValueError as exc: raise ValueError('Invalid PDF encoding') from exc
    if not resume.startswith(b'%PDF-') or len(resume) < 100: raise ValueError('Compile the approved resume before export')
    letter = letter_pdf(request['letter']) if request.get('letter', '').strip() else None
    job = request.get('job')
    if not isinstance(job, dict): raise ValueError('Missing application details')
    root = Path(settings()['directory']).expanduser().resolve()
    destination = root / filename_part(job.get('company'), 'Company', 32) / (filename_part(job.get('title'), 'Role', 40) + '_' + application_id) / ('approved_' + version_id)
    # Check every existing path component; never follow a redirected company folder.
    parent = destination
    while parent != root:
        if parent.is_symlink(): raise ValueError('An application folder is a symbolic link')
        parent = parent.parent
    destination.mkdir(parents=True, mode=0o700, exist_ok=True)
    if not destination.resolve().is_relative_to(root): raise ValueError('Invalid export destination')
    contents = {'Resume.pdf': resume}
    if letter: contents['Cover_Letter.pdf'] = letter
    existing = list(destination.iterdir())
    if existing:
        # The version is immutable. PDF compiler metadata can vary across retries.
        if set(p.name for p in existing) != set(contents): raise ValueError('Incomplete approved packet; choose a new approved version')
        if any(p.is_symlink() or not p.is_file() or not p.read_bytes().startswith(b'%PDF-') for p in existing): raise ValueError('Invalid existing approved packet')
    else:
        written = []
        try:
            for name, content in contents.items():
                path = destination / name
                with path.open('xb') as output:
                    written.append(path); os.chmod(path, 0o600); output.write(content)
        except OSError:
            for path in written: path.unlink(missing_ok=True)
            raise
    return {'directory': str(destination), 'resume_path': str(destination/'Resume.pdf'), 'letter_path': str(destination/'Cover_Letter.pdf') if letter else ''}
