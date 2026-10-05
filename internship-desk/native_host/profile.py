"""Reviewed experience records shared by every resume focus."""
from __future__ import annotations
import hashlib
import re
from native_host.content import template_content, outline

SECTIONS = {'education': 'Education', 'experience': 'Experience', 'projects': 'Projects'}


def validate_library(library):
    if not isinstance(library, list) or not 1 <= len(library) <= 60:
        raise ValueError('Add between 1 and 60 reviewed experience records')
    seen = set()
    for item in library:
        if not isinstance(item, dict) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', str(item.get('id', ''))) or item['id'] in seen:
            raise ValueError('Experience records need unique IDs')
        seen.add(item['id'])
        if item.get('kind') not in SECTIONS or item.get('verified') is not True:
            raise ValueError('Review and confirm every experience record before preparing documents')
        if not isinstance(item.get('heading'), list) or len(item['heading']) != 4 or not all(isinstance(v, str) and len(v) <= 300 for v in item['heading']) or not item['heading'][0].strip():
            raise ValueError('Each experience needs a title and four heading fields')
        if not isinstance(item.get('bullets'), list) or not 1 <= len(item['bullets']) <= 12 or not all(isinstance(v, str) and 1 <= len(v.strip()) <= 700 for v in item['bullets']):
            raise ValueError('Add 1–12 verified facts per experience (up to 700 characters each)')
        if not isinstance(item.get('tags', []), list) or any(t not in ('fpga', 'robotics', 'power') for t in item.get('tags', [])):
            raise ValueError('Invalid experience focus')
    return library


def import_library(root):
    records = {}
    skill_values = []
    for focus in ('fpga', 'robotics', 'power'):
        content = template_content((root/'templates'/f'{focus}.tex').read_text())
        for entry in content['entries']:
            identity = '\n'.join([entry['section'], *entry['heading']]).casefold()
            key = 'fact_' + hashlib.sha256(identity.encode()).hexdigest()[:16]
            existing = records.setdefault(key, {'id': key, 'kind': entry['section'].lower(), 'heading': entry['heading'], 'bullets': [], 'tags': [], 'verified': False})
            existing['bullets'] = list(dict.fromkeys(existing['bullets'] + entry['bullets']))
            existing['tags'].append(focus)
        for row in content['skills']:
            skill_values.extend(v.strip() for v in row['text'].split(',') if v.strip())
    return {'library': list(records.values()), 'skills': ', '.join(dict.fromkeys(skill_values))}


def library_facts(library):
    return '\n\n'.join(' / '.join(item['heading']) + '\n' + '\n'.join('- ' + b for b in item['bullets']) for item in library)


def content_from_outline(baseline, source, escape):
    """Only plain source facts cross the bridge; renderer owns all commands."""
    content = template_content(baseline)
    if not isinstance(source, dict) or not isinstance(source.get('entries'), list) or not isinstance(source.get('skills'), list):
        raise ValueError('Saved source facts are missing')
    entries = []
    for item in source['entries']:
        if not isinstance(item, dict) or item.get('section') not in SECTIONS.values(): raise ValueError('Invalid source section')
        entries.append({'id': item.get('id'), 'kind': item['section'].lower(), 'heading': item.get('heading'), 'bullets': item.get('bullets'), 'verified': True})
    validate_library(entries)
    content['entries'] = [{**item, 'section': SECTIONS[item['kind']], 'heading_tex': r'\resumeSubheading' + ''.join('{' + escape(v) + '}' for v in item['heading'])} for item in entries]
    if not 1 <= len(source['skills']) <= 20: raise ValueError('Invalid skill rows')
    skills, seen = [], set()
    for item in source['skills']:
        if not isinstance(item, dict) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', str(item.get('id',''))) or item['id'] in seen: raise ValueError('Invalid skill row ID')
        seen.add(item['id'])
        if not all(isinstance(item.get(k),str) and 1 <= len(item[k]) <= 5000 for k in ('label','text')): raise ValueError('Invalid skill source')
        skills.append({**item, 'label_tex': escape(item['label'])})
    content['skills'] = skills
    return content


def library_content(baseline, profile, focus, escape):
    library = validate_library(profile['library'])
    missing = set(SECTIONS) - {item['kind'] for item in library}
    if missing: raise ValueError('Add a reviewed record for each required section: ' + ', '.join(sorted(missing)))
    # All education/experience remains available. Limit project candidates by focus.
    projects = sorted((i for i in library if i['kind'] == 'projects'), key=lambda i: focus not in i.get('tags', []))[:8]
    selected = [i for i in library if i['kind'] != 'projects'] + projects
    entries = [{'id': i['id'], 'section': SECTIONS[i['kind']], 'heading': i['heading'], 'bullets': i['bullets']} for i in selected]
    skills = [{'id': 'skills_verified', 'label': 'Technical skills', 'text': profile.get('skills') or 'See verified experience'}]
    return content_from_outline(baseline, {'entries': entries, 'skills': skills}, escape)
