"""Generation contract, escaping, compact inputs, and process recovery regressions."""
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from native_host.content import template_content, compact_facts, assemble, generation_options, plain_tex
from native_host.host import tex_escape, render_resume
from native_host.model import run_model
from native_host.runtime import GenerationError, validate_documents

ROOT = Path(__file__).resolve().parents[1]


def fixture(name='fpga'):
    baseline = (ROOT / 'templates' / f'{name}.tex').read_text()
    content = template_content(baseline)
    payload = {'entries': [{'id': e['id'], 'bullets': e['bullets']} for e in content['entries']],
               'skills': [{'id': e['id'], 'text': e['text']} for e in content['skills']]}
    return baseline, content, payload


class ContentTests(unittest.TestCase):
    def test_compact_profile_preserves_facts_and_annotations_without_template_code(self):
        sources = [fixture(name)[0] for name in ('fpga', 'robotics', 'power')]
        sources[0] = sources[0].replace(r'\end{document}', '\nExtra verified fact inside the document.\n' + r'\end{document}')
        text = 'Reviewed note: graduation date needs confirmation.\n' + '\n'.join(sources) + '\nAdditional verified experience.'
        compact = compact_facts(text)
        self.assertLess(len(compact), len(text) * .5)
        self.assertNotIn(r'\documentclass', compact)
        self.assertNotIn(r'\newcommand', compact)
        self.assertIn('Reviewed note: graduation date needs confirmation.', compact)
        self.assertIn('Additional verified experience.', compact)
        self.assertIn('Extra verified fact inside the document.', compact)
        malformed = r'\documentclass{article} notes \end{document}'
        self.assertEqual(compact_facts(malformed), malformed)
        for name in ('fpga', 'robotics', 'power'):
            for entry in fixture(name)[1]['entries']:
                for bullet in entry['bullets']: self.assertIn(bullet, compact)
        self.assertEqual(compact_facts('Plain profile: 92% result\nNo LaTeX.'), 'Plain profile: 92% result\nNo LaTeX.')

    def test_unrecognized_ids_duplicates_missing_sections_and_oversized_bullets_rejected(self):
        baseline, content, original = fixture()
        variants = []
        bad = copy.deepcopy(original); bad['entries'][0]['id'] = 'invented'; variants.append(bad)
        bad = copy.deepcopy(original); bad['entries'].append(bad['entries'][0]); variants.append(bad)
        bad = copy.deepcopy(original); bad['entries'] = [e for e in bad['entries'] if not e['id'].startswith('education')]; variants.append(bad)
        bad = copy.deepcopy(original); bad['entries'][0]['bullets'] = ['x'*701]; variants.append(bad)
        bad = copy.deepcopy(original); bad['skills'][0]['id'] = 'invented'; variants.append(bad)
        for bad in variants:
            with self.assertRaises(ValueError): assemble(baseline, content, bad, tex_escape)

    def test_model_text_cannot_inject_latex_and_fixed_headers_are_preserved(self):
        baseline, content, payload = fixture()
        payload['entries'][0]['bullets'][0] = r'Literal \input{secret} & 50% #1 _ test ~ ^ $'
        tex = assemble(baseline, content, payload, tex_escape)
        self.assertNotIn(r'\input{secret}', tex)
        self.assertIn(r'\textbackslash{}input\{secret\}', tex)
        self.assertEqual(tex.split(r'\section{Education}')[0], baseline.split(r'\section{Education}')[0])
        validate_documents({'resume_tex': tex, 'cover_letter_markdown': 'review '*150}, baseline)

    @unittest.skipUnless(shutil.which('pdflatex'), 'TeX Live unavailable')
    def test_all_templates_compile_after_content_assembly(self):
        for name in ('fpga', 'robotics', 'power'):
            baseline, content, payload = fixture(name)
            tex = assemble(baseline, content, payload, tex_escape)
            result = render_resume({'template': name, 'resume': tex})
            self.assertEqual(result['pdf_pages'], 1)
            self.assertTrue(result['pdf_base64'])

    def test_explicit_model_and_effort_are_validated(self):
        self.assertEqual(generation_options({})['effort'], 'low')
        for options in ({'model':'invented','effort':'low'}, {'model':'gemini-3.8-flash-low','effort':'unlimited'}, 'oops'):
            with self.assertRaises(ValueError): generation_options({'generation': options})


class ModelProcessTests(unittest.TestCase):
    def run_script(self, source, timeout=3, progress=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            status = run_model([sys.executable, '-c', source], cwd=root, timeout=timeout,
                               prefix=root/'model', input_text='request\n', progress=progress)
            return status, (root/'model.stdout').read_text()

    def test_streaming_reports_progress_before_process_completion(self):
        seen = []
        status, output = self.run_script('''import sys,json,time
assert sys.stdin.read() == 'request\\n'
print(json.dumps({'event':'init'}), flush=True)
time.sleep(1.05)
print(json.dumps({'event':'step_update','step_update':{'step_type':'agent_response'}}), flush=True)
print(json.dumps({'event':'result','result':{'status':'SUCCESS'}}), flush=True)
''', progress=seen.append)
        self.assertEqual(status, 0)
        self.assertIn('SUCCESS', output)
        self.assertEqual(seen[0]['stage'], 'starting_model')
        self.assertIn('drafting', [event['stage'] for event in seen])

    def test_timeout_and_oversized_output_stop_the_process(self):
        with self.assertRaisesRegex(GenerationError, 'timed out'):
            self.run_script('import time; time.sleep(10)', timeout=.1)
        with self.assertRaisesRegex(GenerationError, 'too large'):
            self.run_script("import sys; sys.stdout.write('x'*4000001)")
