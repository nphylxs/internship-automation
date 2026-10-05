#!/usr/bin/env python3
"""Register the existing native pipeline with the extension's answer action."""
import argparse
import json
from pathlib import Path
import shlex
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_host.install import install as install_base


def install(extension_id, browser='brave', destination=None):
    path = install_base(extension_id, browser, destination)
    launcher = Path(json.loads(path.read_text())['path'])
    entry = Path(__file__).resolve().with_name('answer_host.py')
    launcher.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(entry)) + ' "$@"\n')
    return path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('extension_id')
    parser.add_argument('--browser', choices=['brave', 'chrome', 'chromium'], default='brave')
    args = parser.parse_args()
    try:
        print(f'Installed: {install(args.extension_id, args.browser)}')
        print('Reload the extension and the open application page. Resume generation remains available.')
    except (ValueError, OSError) as error: parser.exit(1, f'{error}\n')
