import ast
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from django.conf import settings
from django.test import SimpleTestCase


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class SecuritySettingsTests(SimpleTestCase):
    def _import_settings(self, overrides: dict[str, str]) -> subprocess.CompletedProcess[str]:
        code = f"""
import decouple

values = {overrides!r}
missing = object()

def isolated_config(name, default=missing, cast=missing):
    if name in values:
        value = values[name]
    elif default is not missing:
        value = default
    else:
        raise decouple.UndefinedValueError(name)
    return cast(value) if cast is not missing else value

decouple.config = isolated_config
import core.settings as project_settings
print(project_settings.DEBUG)
"""
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(BACKEND_ROOT)
        with tempfile.TemporaryDirectory() as temp_dir:
            return subprocess.run(
                [sys.executable, "-B", "-c", code],
                cwd=temp_dir,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )

    def test_debug_is_false_by_default(self):
        result = self._import_settings(
            {"SECRET_KEY": "unit-test-only-secret", "ALLOWED_HOSTS": "testserver"}
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "False")

    def test_secret_key_is_required(self):
        result = self._import_settings({"ALLOWED_HOSTS": "testserver"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SECRET_KEY debe definirse", result.stderr)

    def test_default_permission_is_not_allow_any(self):
        defaults = settings.REST_FRAMEWORK["DEFAULT_PERMISSION_CLASSES"]
        self.assertIn("rest_framework.permissions.IsAuthenticated", defaults)
        self.assertNotIn("rest_framework.permissions.AllowAny", defaults)

    def test_otp_is_not_added_to_response_payloads(self):
        source_path = BACKEND_ROOT / "core" / "views.py"
        source = source_path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        forbidden_assignments = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if not isinstance(target, ast.Subscript):
                    continue
                key = target.slice
                if isinstance(key, ast.Constant) and str(key.value).lower() in {"codigo", "otp"}:
                    forbidden_assignments.append(node.lineno)
        self.assertEqual(forbidden_assignments, [], "Un OTP fue agregado a un payload de respuesta.")

