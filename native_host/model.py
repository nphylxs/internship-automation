"""Bounded Antigravity process with live, content-free progress notifications."""
from __future__ import annotations
import json
import os
import selectors
import signal
import subprocess
import time
from generate import GenerationError


def run_model(args, *, cwd, timeout, prefix, input_text, progress=None):
    started, last_progress = time.monotonic(), 0.0
    progress = progress or (lambda event: None)
    source_path = prefix.with_suffix('.stdin')
    source_path.write_text(input_text, encoding='utf-8')
    with source_path.open('rb') as source, prefix.with_suffix('.stdout').open('wb') as output, prefix.with_suffix('.stderr').open('wb') as errors:
        proc = subprocess.Popen(args, cwd=cwd, stdin=source, stdout=subprocess.PIPE,
                                stderr=errors, start_new_session=(os.name == 'posix'))
        completed = False
        try:
            progress({'stage': 'starting_model', 'elapsed_ms': 0})
            pending, total = b'', 0
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    if time.monotonic() - started >= timeout:
                        raise GenerationError(f'Antigravity timed out after {timeout}s')
                    for key, _ in selector.select(timeout=min(0.2, max(0.001, timeout - (time.monotonic() - started)))):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        total += len(chunk)
                        if total > 4_000_000: raise GenerationError('Model response too large')
                        output.write(chunk)
                        pending += chunk
                        while b'\n' in pending:
                            line, pending = pending.split(b'\n', 1)
                            if not line.strip(): continue
                            try: event = json.loads(line)
                            except (ValueError, UnicodeError) as exc: raise GenerationError('Antigravity returned invalid streaming JSON') from exc
                            if not isinstance(event, dict): continue
                            kind = event.get('event')
                            elapsed = time.monotonic() - started
                            if kind in ('init', 'step_update') and (kind == 'init' or elapsed - last_progress >= 1):
                                step = event.get('step_update', {})
                                stage = 'drafting' if isinstance(step, dict) and step.get('step_type') == 'agent_response' else 'model_working'
                                progress({'stage': stage, 'elapsed_ms': round(elapsed * 1000)})
                                last_progress = elapsed
                try:
                    status = proc.wait(timeout=max(0.001, timeout - (time.monotonic() - started)))
                    completed = True
                    return status
                except subprocess.TimeoutExpired as exc: raise GenerationError(f'Antigravity timed out after {timeout}s') from exc
        finally:
            if not completed or proc.poll() is None:
                try:
                    if os.name == 'posix': os.killpg(proc.pid, signal.SIGKILL)
                    else: proc.kill()
                except ProcessLookupError: pass
                proc.wait()
            proc.stdout.close()
