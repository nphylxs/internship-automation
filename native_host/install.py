#!/usr/bin/env python3
"""Register the local bridge for an unpacked extension on Linux or macOS."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import sys


def install(extension_id, browser, destination=None):
    if not re.fullmatch('[a-p]{32}', extension_id):
        raise ValueError('Copy the 32-letter extension ID from brave://extensions')
    root = Path(__file__).resolve().parent
    if destination is None:
        if sys.platform == 'darwin':
            base = Path.home() / 'Library/Application Support'
            folders = {'brave': 'BraveSoftware/Brave-Browser', 'chrome': 'Google/Chrome', 'chromium': 'Chromium'}
        elif sys.platform.startswith('linux'):
            base = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
            folders = {'brave': 'BraveSoftware/Brave-Browser', 'chrome': 'google-chrome', 'chromium': 'chromium'}
        else:
            raise ValueError('This helper installer currently supports Linux and macOS.')
        destination = base / folders[browser] / 'NativeMessagingHosts'
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    # Keep the launcher with the host registration so installation never edits source files.
    launcher = destination / 'internship-desk-host'
    launcher.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(root / 'host.py')) + ' "$@"\n')
    launcher.chmod(0o700)
    manifest = {'name': 'com.internship.desk', 'description': 'Internship Desk local Antigravity bridge',
                'path': str(launcher), 'type': 'stdio', 'allowed_origins': [f'chrome-extension://{extension_id}/']}
    path = destination / 'com.internship.desk.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    path.chmod(0o600)
    return path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('extension_id')
    parser.add_argument('--browser', choices=['brave', 'chrome', 'chromium'], default='brave')
    args = parser.parse_args()
    try:
        print(f'Installed: {install(args.extension_id, args.browser)}')
        print('Reload the extension and click Check local helper in its workspace.')
    except (ValueError, OSError) as exc:
        parser.exit(1, f'{exc}\n')
