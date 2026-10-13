#!/usr/bin/env python3
"""
Check that Celery tasks which mutate async state ("processing": True)
always wrap the execution in a try-finally block.

Without try-finally, a SIGKILL/OOM on the worker leaves the flag set forever
and the scheduler enters degraded mode (see scheduler/controller.py:163-165).

Usage:
    python check_async_patterns.py file1.py file2.py ...

Exit codes:
    0 — no violations
    1 — violations found (or parse errors)
"""
import ast
import sys
from pathlib import Path


def _is_task_decorator(node: ast.expr) -> bool:
    """Return True if the decorator node looks like a Celery @*.task or @*.task(...)."""
    if isinstance(node, ast.Attribute):
        return node.attr == "task"
    if isinstance(node, ast.Name):
        return node.id == "task"
    if isinstance(node, ast.Call):
        return _is_task_decorator(node.func)
    return False


def _processing_true_locations(func_node: ast.FunctionDef) -> list[tuple[int, int]]:
    """Return (line, col) for every {"processing": True, ...} dict inside the function."""
    hits: list[tuple[int, int]] = []
    for node in ast.walk(func_node):
        if not isinstance(node, ast.Dict):
            continue
        for key, val in zip(node.keys, node.values):
            if (
                isinstance(key, ast.Constant)
                and key.value == "processing"
                and isinstance(val, ast.Constant)
                and val.value is True
            ):
                hits.append((node.lineno, node.col_offset))
    return hits


def _has_try_finally(func_node: ast.FunctionDef) -> bool:
    """Return True if the function body contains at least one try-finally block."""
    for node in ast.walk(func_node):
        if isinstance(node, ast.Try) and node.finalbody:
            return True
        # Python 3.11+ splits TryStar from Try; finalbody still present on ast.Try
    return False


def check_file(filepath: str) -> list[str]:
    """Analyse one Python file and return a list of violation strings."""
    errors: list[str] = []
    try:
        source = Path(filepath).read_text(encoding="utf-8")
    except OSError as exc:
        return [f"{filepath}: cannot read: {exc}"]

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as exc:
        return [f"{filepath}:{exc.lineno}:0: parse error: {exc.msg}"]

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        if not any(_is_task_decorator(d) for d in node.decorator_list):
            continue

        hits = _processing_true_locations(node)
        if not hits:
            continue

        if _has_try_finally(node):
            continue

        for lineno, col in hits:
            errors.append(
                f'{filepath}:{lineno}:{col}: E001 [machina/async-state-missing-finally] '
                f'"processing": True inside Celery task `{node.name}` has no try-finally. '
                f"The flag will not be cleared on SIGKILL/OOM and the scheduler enters "
                f"degraded mode. Wrap the execution in try/except/finally and reset the "
                f"flag unconditionally in the finally block. "
                f"See: https://github.com/machina-sports/.github/blob/main/docs/async-patterns.md"
            )

    return errors


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: check_async_patterns.py <file1.py> [file2.py ...]", file=sys.stderr)
        sys.exit(0)

    all_errors: list[str] = []
    for path in sys.argv[1:]:
        if path.endswith(".py"):
            all_errors.extend(check_file(path))

    if all_errors:
        for err in all_errors:
            print(err)
        sys.exit(1)


if __name__ == "__main__":
    main()
