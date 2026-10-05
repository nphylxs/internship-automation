import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from answer_host import generate_answer, handle
from install_helper import install


class AnswerTests(unittest.TestCase):
    def request(self):
        return {'action':'generate_answer','question':'Why are you interested?','max_length':300,
                'job':{'title':'Intern','description':'Verified engineering job description. '*10},
                'profile':{'facts':'Verified robotics experience. '*10},
                'generation':{'model':'gemini-3.8-flash-low','effort':'low'}}

    def model(self,payload,status='SUCCESS'):
        def run(args,**kwargs):
            self.assertIn('--sandbox',args)
            self.assertIn('Do not use tools',kwargs['input_text'])
            self.assertIn('Verified robotics',kwargs['input_text'])
            self.assertNotIn('resume_outline',kwargs['input_text'])
            schema=json.loads(Path(args[args.index('--json-schema')+1]).read_text())
            self.assertEqual(schema['properties']['answer']['maxLength'],300)
            kwargs['prefix'].with_suffix('.stdout').write_text(json.dumps({'event':'result','result':{'status':status,'structured_output':payload,'error':'Provider temporarily unavailable' if status!='SUCCESS' else ''}}))
            return 0 if status=='SUCCESS' else 1
        return run

    def test_compact_answer_action_and_missing_fact_fallback(self):
        for payload in [{'answer':'I have verified robotics experience.','review_notes':['Review before inserting.']},{'answer':'','review_notes':['Add your available start date.']}]:
            with patch('answer_host.host.agy_path',return_value='/mock/agy'),patch('answer_host.run_model',side_effect=self.model(payload)):
                result=generate_answer(self.request())
            self.assertEqual(result['answer'],payload['answer'])
            self.assertIn('model_ms',result['timings'])

    def test_rejects_bad_inputs_and_model_outputs(self):
        for update in [{'max_length':0},{'max_length':True},{'question':'x'*2001},{'profile':{}}]:
            with self.assertRaises(ValueError):generate_answer(self.request()|update)
        for payload in [{'answer':'x'*301,'review_notes':[]},{'answer':'fine','review_notes':'invalid'},{'answer':'fine','extra':1,'review_notes':[]}]:
            with patch('answer_host.host.agy_path',return_value='/mock/agy'),patch('answer_host.run_model',side_effect=self.model(payload)),self.assertRaises(ValueError):generate_answer(self.request())

    def test_provider_errors_are_actionable_and_existing_pipeline_is_delegated(self):
        with patch('answer_host.host.agy_path',return_value='/mock/agy'),patch('answer_host.run_model',side_effect=self.model({},'ERROR')),self.assertRaisesRegex(ValueError,'Provider temporarily unavailable'):generate_answer(self.request())
        with patch('answer_host.host.handle',return_value={'resume':'saved'}) as original:
            self.assertEqual(handle({'action':'generate'}),{'resume':'saved'})
            original.assert_called_once()

    def test_installer_uses_new_entry_and_preserves_specific_origin(self):
        with tempfile.TemporaryDirectory() as folder:
            path=install('a'*32,'brave',folder)
            manifest=json.loads(path.read_text())
            self.assertEqual(manifest['allowed_origins'],['chrome-extension://'+'a'*32+'/'])
            self.assertIn('answer_host.py',Path(manifest['path']).read_text())
            self.assertTrue(Path(manifest['path']).stat().st_mode & 0o100)


if __name__=='__main__':unittest.main()
