import contextlib
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("ab-run.py")
SPEC = importlib.util.spec_from_file_location("ab_run", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load {SCRIPT}")
ab_run = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ab_run)


class AbRunWorkingDirectoryTest(unittest.TestCase):
    def test_runs_message_in_target_repo_without_passing_repo_as_message(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            target_repo = root / "fixture"
            target_repo.mkdir()
            prompt_file = root / "prompt.md"
            prompt_file.write_text("Run the fixture task", encoding="utf-8")
            out_dir = root / "output"
            config_home = root / "config"
            config_home.mkdir()

            argv = [
                str(SCRIPT),
                "--repo", str(target_repo),
                "--prompt-file", str(prompt_file),
                "--model", "opencode-zen/test-model",
                "--arms", "off",
                "--out", str(out_dir),
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(ab_run, "arm_config", return_value=config_home),
                mock.patch.object(ab_run.subprocess, "call", return_value=0) as call,
                mock.patch.object(ab_run.subprocess, "run") as measure,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                ab_run.main()

            command = call.call_args.args[0]
            kwargs = call.call_args.kwargs
            self.assertEqual(command[0:3], ["opencode", "run", "Run the fixture task"])
            self.assertNotIn(str(target_repo), command)
            self.assertEqual(kwargs["cwd"], str(target_repo.resolve()))
            self.assertEqual(kwargs["env"]["PWD"], str(target_repo.resolve()))
            measure.assert_called_once()


if __name__ == "__main__":
    unittest.main()
