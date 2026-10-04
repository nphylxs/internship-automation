import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from native_host import exports

PDF = b'%PDF-1.4\n' + b'x' * 120

class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(exports, 'SETTINGS_PATH', self.root / 'settings.json')
        self.patch.start(); self.addCleanup(self.patch.stop)
        exports.configure({'directory': str(self.root / 'applications'), 'enabled': True})
        self.request = {'template': 'fpga', 'job': {'company': '../../ACME / Labs', 'title': 'Hardware Intern'},
                        'letter': 'Cover letter ' * 100, 'pdf_base64': base64.b64encode(PDF).decode()}

    def test_company_names_and_unique_versions(self):
        with patch.object(exports, 'letter_pdf', return_value=PDF):
            first = exports.export_documents(self.request)
            second = exports.export_documents(self.request)
        self.assertNotEqual(first['resume_path'], second['resume_path'])
        for result in (first, second):
            for key in ('resume_path', 'letter_path'):
                path = Path(result[key])
                self.assertTrue(path.is_relative_to(self.root / 'applications'))
                self.assertIn('ACME_Labs_Hardware_Intern', path.name)
                self.assertIn('Divyamshu_Shrestha', path.name)
                self.assertEqual(path.read_bytes(), PDF)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_disabled_saves_are_skipped_but_manual_export_works(self):
        exports.configure({'directory': str(self.root / 'applications'), 'enabled': False})
        with patch.object(exports, 'letter_pdf', return_value=PDF) as render:
            self.assertEqual(exports.export_documents(self.request), {'skipped': True})
            render.assert_not_called()
            self.assertIn('resume_path', exports.export_documents({**self.request, 'force': True}))

    def test_invalid_pdf_and_compile_failure_create_no_documents(self):
        for encoded in ('not base64', base64.b64encode(b'not a pdf').decode()):
            with self.assertRaises(ValueError): exports.export_documents({**self.request, 'pdf_base64': encoded})
        with patch.object(exports, 'letter_pdf', side_effect=ValueError('compile failed')):
            with self.assertRaises(ValueError): exports.export_documents(self.request)
        self.assertEqual(list((self.root / 'applications').rglob('*.pdf')), [])

    def test_folder_settings_and_symlink_protection(self):
        with self.assertRaises(ValueError): exports.configure({'directory': 'relative/path', 'enabled': True})
        (self.root / 'applications' / 'ACME_Labs').symlink_to(self.root, target_is_directory=True)
        with patch.object(exports, 'letter_pdf', return_value=PDF):
            with self.assertRaises(ValueError): exports.export_documents(self.request)

    def test_letter_text_is_escaped_not_executed(self):
        captured = []
        def compile_pdf(folder, source, compiler, timeout):
            captured.append(source)
            path = folder / 'letter.pdf'; path.write_bytes(PDF); return path
        with patch('generate.compile_resume', side_effect=compile_pdf), patch('native_host.exports.shutil.which', return_value='/mock/tex'):
            exports.letter_pdf('A letter with 90% target & engineering. ' * 5 + r'\input{/etc/passwd}')
        self.assertIn(r'90\% target \&', captured[0])
        self.assertNotIn(r'\input{/etc/passwd}', captured[0])
