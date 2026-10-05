import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from native_host.host import read_message, write_message, handle, parse_output, validate_input, MAX_BYTES, render_resume, approved_projects, PROJECT_SCHEMA
from native_host.install import install

class ExtensionHostTests(unittest.TestCase):
    def test_native_protocol_unicode_and_eof(self):
        stream = io.BytesIO()
        write_message(stream, {'name': 'résumé'})
        stream.seek(0)
        self.assertEqual(read_message(stream), {'name': 'résumé'})
        self.assertIsNone(read_message(stream))

    def test_invalid_frames(self):
        for data in [b'\x01', struct.pack('=I', MAX_BYTES+1), struct.pack('=I', 10)+b'{}']:
            with self.assertRaises(ValueError): read_message(io.BytesIO(data))

    def test_no_arbitrary_actions(self):
        with self.assertRaises(ValueError): handle({'action':'run', 'command':'echo unsafe'})
        with self.assertRaises(ValueError): validate_input({'job':{},'profile':{}})

    def test_import_is_limited_to_approved_templates(self):
        result = handle({'action':'profile', 'path':'/etc/passwd'})
        self.assertIn('APPROVED SOURCE: fpga', result['facts'])
        self.assertNotIn('root:x:', result['facts'])

    def test_installer_allows_only_specific_extension(self):
        with tempfile.TemporaryDirectory() as folder:
            path = install('a'*32, 'brave', folder)
            manifest = json.loads(path.read_text())
            self.assertEqual(manifest['allowed_origins'], ['chrome-extension://'+'a'*32+'/'])
            self.assertTrue(Path(manifest['path']).stat().st_mode & 0o100)
            with self.assertRaises(ValueError): install('../evil', 'brave', folder)

    def test_generation_uses_profile_and_strict_output(self):
        from native_host.content import template_content
        baseline = (Path(__file__).resolve().parents[1] / 'Templates/fpga.tex').read_text()
        content = template_content(baseline)
        payload = {'entries': [{'id': e['id'], 'bullets': e['bullets']} for e in content['entries']], 'skills': [{'id': e['id'], 'text': e['text']} for e in content['skills']], 'letter':'Cover letter '*90, 'changes':['Tailored content'], 'review_notes':['Check dates']}
        def fake_run(args, **kwargs):
            self.assertIn('--sandbox', args)
            self.assertEqual(args[args.index('--model') + 1], 'gemini-3.8-flash-low')
            self.assertEqual(args[args.index('--effort') + 1], 'low')
            self.assertNotIn('baseline_tex', kwargs['input_text'])
            self.assertNotIn('--dangerously-skip-permissions', args)
            self.assertIn('verified facts', kwargs['input_text'])
            kwargs['prefix'].with_suffix('.stdout').write_text(json.dumps({'event':'result','result':{'status':'SUCCESS','structured_output':payload}}))
            return 0
        with patch('native_host.host.agy_path', return_value='/mock/agy'), patch('native_host.host.run_model', side_effect=fake_run), patch('native_host.host.render_resume', side_effect=AssertionError('Generation must not compile PDFs')):
            result = handle({'action':'generate','job':{'title':'Intern','description':'Full posting '*20},'profile':{'facts':'verified facts '*20}})
        self.assertIn(r'\begin{document}', result['resume'])
        self.assertTrue(result['render_pending'])
        self.assertNotIn('pdf_base64', result)
        self.assertIn('model_ms', result['timings'])
        self.assertEqual(result['approved_projects'], [])

    def test_rejects_malformed_model_result(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'out'
            for value in [{}, {'event':'result','result':{'status':'SUCCESS','structured_output':{'resume':'x'}}}]:
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError): parse_output(path)

    def test_render_rejects_template_changes_and_unapproved_projects(self):
        baseline = (Path(__file__).resolve().parents[1] / 'Templates/fpga.tex').read_text()
        from generate import GenerationError
        with self.assertRaises(GenerationError):
            render_resume({'resume': baseline.replace('10pt', '12pt')})
        with self.assertRaises(ValueError):
            render_resume({'resume': baseline, 'approved_projects': [{'title': 'Idea', 'scope': 'Build it'}]})
        with self.assertRaises(ValueError):
            render_resume({'resume': baseline, 'template': '../secrets'})

    def test_planned_project_escaping_and_template_preservation(self):
        baseline = (Path(__file__).resolve().parents[1] / 'Templates/fpga.tex').read_text()
        captured = []
        def compiler(folder, source, executable, timeout):
            captured.append(source)
            path = folder / 'resume.pdf'; path.write_bytes(b'%PDF-test'); return path
        with patch('native_host.host.compile_resume', side_effect=compiler), patch('native_host.host.shutil.which', return_value='/mock/pdflatex'):
            result = render_resume({'resume': baseline, 'approved_projects': [{'title': 'FPGA & DSP', 'scope': r'Plan 90% coverage; \input{secret}', 'approved': True}]})
        self.assertTrue(captured[0].startswith(baseline.split(r'\begin{document}')[0]))
        self.assertIn('Planned Projects', captured[0])
        self.assertIn(r'FPGA \& DSP (Planned)', captured[0])
        self.assertNotIn(r'\input{secret}', captured[0])
        self.assertEqual(result['resume'], baseline)

    def test_suggestions_have_bounded_schema_and_no_automatic_approval(self):
        project = {k: 'A concrete project plan' for k in ['title', 'relevance', 'scope', 'build_plan', 'success_targets', 'effort']}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'result'
            path.write_text(json.dumps({'event':'result','result':{'status':'SUCCESS','structured_output':{'projects':[project]}}}))
            self.assertNotIn('approved', parse_output(path, PROJECT_SCHEMA)['projects'][0])
            project['scope'] = 'x' * 351
            path.write_text(json.dumps({'event':'result','result':{'status':'SUCCESS','structured_output':{'projects':[project]}}}))
            with self.assertRaises(ValueError): parse_output(path, PROJECT_SCHEMA)
