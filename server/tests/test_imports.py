"""Every relative import in the server resolves, including the ones inside
functions that only run on some requests. Moving code between packages
(api/ -> services/) silently breaks `from .x import y` otherwise: nothing
fails until that branch runs in production."""

from __future__ import annotations

import ast
import importlib
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "server"
sys.path.insert(0, str(ROOT))


def _module_name(path: Path) -> str:
    parts = list(path.relative_to(ROOT).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def relative_imports() -> list[tuple[str, int, str, str | None]]:
    """(file, line, absolute module, imported name or None) for each relative import."""
    found = []
    for path in sorted(PACKAGE.rglob("*.py")):
        module = _module_name(path)
        package = module if path.name == "__init__.py" else module.rpartition(".")[0]
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path))):
            if isinstance(node, ast.ImportFrom) and node.level:
                base = importlib.util.resolve_name("." * node.level + (node.module or ""), package)
                for alias in node.names:
                    found.append((str(path.relative_to(ROOT)), node.lineno, base, alias.name))
    return found


class RelativeImportsResolve(unittest.TestCase):
    def test_every_relative_import_resolves(self) -> None:
        broken = []
        for file, line, base, name in relative_imports():
            try:
                module = importlib.import_module(base)
            except ImportError as e:
                broken.append(f"{file}:{line} from {base} import {name}: {e}")
                continue
            if name != "*" and not hasattr(module, name) and importlib.util.find_spec(f"{base}.{name}") is None:
                broken.append(f"{file}:{line} from {base} import {name}: no such name")
        self.assertEqual(broken, [], "\n".join(broken))


if __name__ == "__main__":
    unittest.main()
