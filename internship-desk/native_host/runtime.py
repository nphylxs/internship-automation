"""Private writes, bounded subprocesses and validated LaTeX compilation."""
from __future__ import annotations
import os
from pathlib import Path
import re
import signal
import subprocess
import uuid

class GenerationError(Exception):
    """An actionable per-job failure; preserved artifacts may help diagnose it."""

def write_text(path: Path, text: str) -> None:
    """Atomically write private data without reusing a possibly stale output."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise GenerationError(f"Refusing to replace symlink: {path}")
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("x", encoding="utf-8") as handle:
            os.chmod(temp, 0o600)
            handle.write(text)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)

def run_bounded(args: list[str], *, cwd: Path, timeout: int,
                prefix: Path, input_text: str | None = None,
                env: dict[str, str] | None = None) -> int:
    """Run without a shell and terminate child processes on timeout (POSIX)."""
    with prefix.with_suffix(".stdout").open("wb") as stdout, \
            prefix.with_suffix(".stderr").open("wb") as stderr:
        proc = subprocess.Popen(
            args, cwd=cwd, stdin=subprocess.PIPE if input_text else subprocess.DEVNULL,
            stdout=stdout, stderr=stderr, env=env, start_new_session=(os.name == "posix"),
        )
        try:
            proc.communicate(input_text.encode("utf-8") if input_text else None,
                             timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
            proc.communicate()
            raise GenerationError(f"{Path(args[0]).name} timed out after {timeout}s") from exc
        return proc.returncode

def without_comments(tex: str) -> str:
    return re.sub(r"(?<!\\)%[^\n]*", "", tex)

def validate_documents(payload: dict, baseline: str) -> None:
    tex, letter = payload["resume_tex"], payload["cover_letter_markdown"]
    marker = r"\begin{document}"
    if baseline.count(marker) != 1 or tex.count(marker) != 1:
        raise GenerationError("Expected one complete LaTeX document")
    baseline_preamble, baseline_body = baseline.split(marker)
    preamble, body = tex.split(marker)
    if preamble != baseline_preamble:
        raise GenerationError("Generated resume changed the approved LaTeX preamble")
    if len(body.strip()) < 500 or not body.rstrip().endswith(r"\end{document}"):
        raise GenerationError("Generated resume is incomplete")
    if body.count(r"\end{document}") != 1:
        raise GenerationError("Generated resume contains multiple document endings")
    if "^^" in body:
        raise GenerationError("TeX character-code escapes are not allowed")
    # Only existing body commands/environments may be used. This keeps model
    # output from adding file IO, macro definitions, or low-level TeX primitives.
    baseline_clean, body_clean = without_comments(baseline_body), without_comments(body)
    command_pattern = r"\\([A-Za-z@]+|[^A-Za-z@\s])"
    allowed_commands = set(re.findall(command_pattern, baseline_clean)) | {'textbackslash', 'textasciitilde', 'textasciicircum', '&', '%', '$', '#', '_', '{', '}'}
    new_commands = set(re.findall(command_pattern, body_clean)) - allowed_commands
    if new_commands:
        raise GenerationError("Generated resume added unapproved LaTeX commands: " +
                              ", ".join(sorted(new_commands)))
    environment_pattern = r"\\(?:begin|end)\s*\{([^}]+)\}"
    if set(re.findall(environment_pattern, body_clean)) - set(re.findall(environment_pattern, baseline_clean)):
        raise GenerationError("Generated resume added an unapproved LaTeX environment")
    # Preserve the applicant's contact header exactly, including approved links.
    header_pattern = r"\\begin\{center\}.*?\\end\{center\}"
    header = re.search(header_pattern, baseline_body, flags=re.S)
    if header and header.group() not in body:
        raise GenerationError("Generated resume changed the applicant contact header")
    baseline_links = set(re.findall(r"\\href\s*\{([^}]+)\}", baseline_body))
    if set(re.findall(r"\\href\s*\{([^}]+)\}", body)) != baseline_links:
        raise GenerationError("Generated resume changed approved links")
    words = len(letter.split())
    if not 100 <= words <= 550:
        raise GenerationError("Cover letter must contain 100–550 words")
    if re.search(r"\[(?:your|insert|company|name|date|address|hiring)[^\]]*\]", letter, re.I):
        raise GenerationError("Cover letter contains an unresolved placeholder")

def compile_resume(attempt: Path, tex: str, compiler: str, timeout: int) -> Path:
    compile_dir = attempt / "compile"
    compile_dir.mkdir()
    write_text(compile_dir / "resume.tex", tex)
    environment = os.environ.copy()
    environment.update({"openin_any": "p", "openout_any": "p", "shell_escape": "f"})
    args = [compiler, "-no-shell-escape", "-interaction=nonstopmode",
            "-halt-on-error", "-file-line-error", "resume.tex"]
    status = run_bounded(args, cwd=compile_dir, timeout=timeout,
                         prefix=attempt / "pdflatex", env=environment)
    pdf = compile_dir / "resume.pdf"
    if status or not pdf.is_file() or pdf.stat().st_size < 100:
        raise GenerationError("Resume did not compile; inspect pdflatex.stdout and compile/resume.log")
    with pdf.open("rb") as handle:
        if handle.read(5) != b"%PDF-":
            raise GenerationError("Compiler output is not a PDF")
    return pdf
