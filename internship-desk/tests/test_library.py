import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from native_host.host import handle,baseline_for,tex_escape
from native_host.profile import library_content,validate_library
from native_host.content import assemble,outline
from native_host.exports import export_packet
from native_host import exports

class LibraryTests(unittest.TestCase):
    def test_resume_only_generation_sends_reviewed_facts_once(self):
        profile = handle({'action': 'import_library'})
        for entry in profile['library']: entry['verified'] = True
        profile['facts'] = 'A separate reviewed correction.'
        _, baseline = baseline_for({'template': 'fpga'})
        source = library_content(baseline, profile, 'fpga', tex_escape)
        chosen = [next(e for e in source['entries'] if e['section'] == section) for section in ('Education', 'Experience', 'Projects')]
        payload = {'entries': [{'id': e['id'], 'bullets': e['bullets'][:1]} for e in chosen], 'skills': [{'id': source['skills'][0]['id'], 'text': 'Python'}], 'letter': '', 'changes': [], 'review_notes': []}
        def fake_run(args, **kwargs):
            message = json.loads(kwargs['input_text'])['message']['content']
            inputs = json.loads('{' + message.split('\n{', 1)[1])
            self.assertEqual(inputs['profile']['facts'], profile['facts'])
            self.assertNotIn('library', inputs['profile'])
            self.assertEqual(inputs['resume_outline']['entries'][0]['bullets'], profile['library'][0]['bullets'])
            schema = json.loads(Path(args[args.index('--json-schema') + 1]).read_text())
            self.assertNotIn('letter', schema['properties'])
            self.assertNotIn('letter', schema['required'])
            kwargs['prefix'].with_suffix('.stdout').write_text(json.dumps({'event': 'result', 'result': {'status': 'SUCCESS', 'structured_output': {k: v for k, v in payload.items() if k != 'letter'}}}))
            return 0
        with patch('native_host.host.agy_path', return_value='/mock/agy'), patch('native_host.host.run_model', side_effect=fake_run):
            result = handle({'action': 'generate', 'include_letter': False, 'template': 'fpga', 'profile': profile, 'job': {'title': 'Intern', 'description': 'Full job description. ' * 10}})
        self.assertEqual(result['letter'], '')
        self.assertTrue(result['render_pending'])

    def test_import_requires_review_and_shared_facts_render_in_any_focus(self):
        profile=handle({'action':'import_library'})
        with self.assertRaises(ValueError):validate_library(profile['library'])
        for entry in profile['library']:entry['verified']=True
        profile['library'][0]['heading'][3]='Expected graduation: May 2029'
        for focus in ('fpga','robotics','power'):
            _,base=baseline_for({'template':focus})
            content=library_content(base,profile,focus,tex_escape)
            selected=[next(e for e in content['entries'] if e['section']==section) for section in ('Education','Experience','Projects')]
            result=handle({'action':'render','template':focus,'source_outline':outline(content),'entries':[{'id':e['id'],'bullets':e['bullets'][:1]} for e in selected],'skills':[{'id':content['skills'][0]['id'],'text':'Python, Verilog'}]})
            self.assertIn('May 2029',result['resume'])
            self.assertTrue(result['pdf_base64'])

    def test_packet_exports_are_idempotent_and_versions_are_separate(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(exports,'SETTINGS_PATH',Path(folder)/'settings.json'):
            exports.configure({'directory':folder,'enabled':False})
            request={'approved':True,'application_id':'application-one','version_id':'version-one','job':{'company':'Example','title':'Intern'},'pdf_base64':__import__('base64').b64encode(b'%PDF-'+b'x'*100).decode(),'letter':''}
            first=export_packet(request);second=export_packet(request)
            self.assertEqual(first,second);self.assertFalse(first['letter_path'])
            other=export_packet({**request,'version_id':'version-two'})
            self.assertNotEqual(first['directory'],other['directory'])
            self.assertTrue(Path(first['resume_path']).exists())
            with self.assertRaises(ValueError):export_packet({**request,'application_id':'../../elsewhere'})
            with self.assertRaises(ValueError):export_packet({**request,'approved':False})
