#!/usr/bin/env python3
"""Run the real helper with isolated service fakes and actual file copying."""

import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import runpy
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch


HELPER = Path(__file__).with_name('clone_wp_env.py')


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.run = runpy.run_path(str(HELPER))['run']

    def test_wait_messages_repeat_with_elapsed_time_and_stop_after_success(self):
        messages = io.StringIO()
        with contextlib.redirect_stderr(messages), patch.dict(self.run.__globals__, PROGRESS_INTERVAL_SECONDS=0.2):
            output = self.run([sys.executable, '-c',
                               'import time; print("native output", flush=True); time.sleep(1.25)'],
                              Path.cwd(), capture=True, progress='WordPress startup')
            after_exit = messages.getvalue()
            time.sleep(0.25)
            self.assertEqual(messages.getvalue(), after_exit)
        self.assertEqual(output, 'native output\n')
        lines = after_exit.splitlines()
        self.assertGreaterEqual(len(lines), 2)
        self.assertIn('WordPress startup still running (0s elapsed).', lines)
        self.assertIn('WordPress startup still running (1s elapsed).', lines)

    def test_wait_messages_stop_and_preserve_failure_exit_code(self):
        messages = io.StringIO()
        with contextlib.redirect_stderr(messages), patch.dict(self.run.__globals__, PROGRESS_INTERVAL_SECONDS=0.05):
            with self.assertRaises(subprocess.CalledProcessError) as failed:
                self.run([sys.executable, '-c', 'import time; time.sleep(0.2); raise SystemExit(7)'],
                         Path.cwd(), progress='WordPress startup')
            after_exit = messages.getvalue()
            time.sleep(0.1)
            self.assertEqual(messages.getvalue(), after_exit)
        self.assertEqual(failed.exception.returncode, 7)
        self.assertIn('WordPress startup still running', after_exit)

    def test_fast_command_has_no_wait_message(self):
        messages = io.StringIO()
        with contextlib.redirect_stderr(messages):
            self.run([sys.executable, '-c', 'pass'], Path.cwd(), progress='WordPress startup')
        self.assertEqual(messages.getvalue(), '')


FAKE = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['CLONE_TEST_ROOT'])
name, args = Path(sys.argv[0]).name, sys.argv[1:]
cwd = Path.cwd()
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps({'tool': name, 'args': args, 'cwd': str(cwd)}) + '\n')
if name == 'wp-env':
    source = cwd.name == 'source checkout'
    running = source or (root / 'started').exists()
    config = json.loads((cwd / '.wp-env.json').read_text())
    state = {'status': 'running' if running else 'uninitialized',
             'configPath': str(cwd), 'installPath': str(root / ('source-install' if source else 'target-install'))}
    if running:
        port = config['port']
        state.update(runtime='docker', urls={'development': f'http://example.test:{port}'})
    print(json.dumps(state))
elif name == 'npm':
    if args != ['run', 'start']:
        sys.exit(71)
    if os.environ.get('CLONE_TEST_FAIL') == 'startup':
        sys.exit(44)
    (root / 'started').touch()
elif name == 'docker':
    source = 'source-install' in args[args.index('--file') + 1]
    if 'export' in args:
        print('source SQL -- échantillon' if source else 'old target SQL')
        if source and os.environ.get('CLONE_TEST_FAIL') == 'export':
            sys.exit(45)
    elif 'import' in args:
        (root / 'imported.sql').write_bytes(sys.stdin.buffer.read())
        if os.environ.get('CLONE_TEST_FAIL') == 'import':
            sys.exit(42)
    elif 'search-replace' in args:
        if os.environ.get('CLONE_TEST_FAIL') == 'urls':
            sys.exit(43)
    elif 'list' in args:
        port = json.loads((cwd / '.wp-env.json').read_text())['port']
        print(json.dumps([{'blog_id': i+1, 'url': f'http://{prefix}example.test:{port}/'}
                          for i, prefix in enumerate(('', 'paris.', 'lyon.', 'marseille.'))]))
elif name == 'curl':
    print('500' if os.environ.get('CLONE_TEST_FAIL') == 'http' else '200', end='')
else:
    sys.exit(72)
'''


@unittest.skipUnless(shutil.which('rsync'), 'rsync is required for the file-copy smoke tests')
class CloneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wp clone smoke ')
        self.root = Path(self.temp.name)
        self.source, self.target = self.root / 'source checkout', self.root / 'target checkout'
        self.config = {
            'core': 'https://example.invalid/wordpress.zip',
            'plugins': ['./plugins/local'], 'themes': ['./themes/local'],
            'port': 8888, 'testsEnvironment': False, 'multisite': True,
            'config': {'MULTISITE': True, 'SUBDOMAIN_INSTALL': True,
                       'WP_HOME': 'http://example.test', 'WP_SITEURL': 'http://example.test',
                       'DOMAIN_CURRENT_SITE': 'example.test:8888'},
            'mappings': {'wp-content': './.wp-env-data/wp-content'},
        }
        for project in (self.source, self.target):
            project.mkdir()
            (project / '.wp-env.json').write_text(json.dumps(self.config))
            (project / 'package.json').write_text(json.dumps({'scripts': {'start': 'unused fixture'}}))
            (project / 'themes/local').mkdir(parents=True)
            (project / 'themes/local/branch.php').write_text(project.name)
        self.source_content = self.source / '.wp-env-data/wp-content'
        (self.source_content / 'uploads').mkdir(parents=True)
        (self.source_content / 'uploads/media.jpg').write_bytes(b'source photo\x00\xff')
        binaries = self.root / 'bin'
        binaries.mkdir()
        for name in ('wp-env', 'docker', 'npm', 'curl'):
            path = binaries / name
            path.write_text(FAKE)
            path.chmod(0o755)
        self.env = dict(os.environ, PATH=str(binaries) + os.pathsep + os.environ['PATH'],
                        CLONE_TEST_ROOT=str(self.root))
        self.before_source = self.tree(self.source)

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def tree(path):
        return {str(entry.relative_to(path)): entry.read_bytes()
                for entry in path.rglob('*') if entry.is_file()}

    def invoke(self, *args, fail=None):
        env = dict(self.env)
        if fail:
            env['CLONE_TEST_FAIL'] = fail
        return subprocess.run([sys.executable, str(HELPER), '--source', str(self.source), *args],
                              cwd=self.target, env=env, text=True, capture_output=True)

    def calls(self):
        path = self.root / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def snapshot(self):
        return next((self.target / '.wp-env-data').glob('clone-*'))

    def existing(self):
        self.config['port'] = 7777
        (self.target / '.wp-env.json').write_text(json.dumps(self.config))
        content = self.target / '.wp-env-data/wp-content/uploads'
        content.mkdir(parents=True)
        (content / 'media.jpg').write_bytes(b'old target photo')
        (self.root / 'started').touch()

    def test_fresh_clone_defaults_and_full_command_flow(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads((self.target / '.wp-env.json').read_text())
        port = config['port']
        self.assertIn(port, range(9000, 10000))
        self.assertNotEqual(port, 8888)
        self.assertEqual(config['config']['WP_HOME'], f'http://example.test:{port}')
        self.assertEqual(config['config']['WP_SITEURL'], f'http://example.test:{port}')
        self.assertEqual(config['config']['DOMAIN_CURRENT_SITE'], f'example.test:{port}')
        self.assertFalse(config['autoPort'])
        self.assertEqual((self.target / '.wp-env-data/wp-content/uploads/media.jpg').read_bytes(), b'source photo\x00\xff')
        self.assertEqual((self.target / 'themes/local/branch.php').read_text(), 'target checkout')
        self.assertEqual(self.tree(self.source), self.before_source)
        self.assertEqual((self.root / 'imported.sql').read_bytes(), 'source SQL -- échantillon\n'.encode())
        self.assertEqual(self.snapshot().stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.snapshot() / 'source.sql').stat().st_mode & 0o777, 0o600)
        calls = self.calls()
        startup = next(i for i, call in enumerate(calls) if call['tool'] == 'npm')
        imported = next(i for i, call in enumerate(calls) if 'import' in call['args'])
        replaced = next(i for i, call in enumerate(calls) if 'search-replace' in call['args'])
        self.assertLess(startup, imported)
        self.assertLess(imported, replaced)
        replacement = calls[replaced]['args']
        self.assertIn('--url=http://example.test:8888', replacement)
        self.assertIn('example.test:8888', replacement)
        self.assertIn(f'example.test:{port}', replacement)
        self.assertIn('--all-tables-with-prefix', replacement)
        self.assertIn('--precise', replacement)
        self.assertEqual(sum(call['tool'] == 'curl' for call in calls), 4)
        self.assertFalse(any('provision' in call['args'] or 'cleanup' in call['args'] for call in calls))

    def test_dry_run_has_no_target_or_source_side_effects(self):
        before = self.tree(self.target)
        result = self.invoke('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tree(self.target), before)
        self.assertFalse((self.target / '.wp-env-data').exists())
        self.assertEqual(self.tree(self.source), self.before_source)
        self.assertTrue(all(call['tool'] == 'wp-env' for call in self.calls()))

    def test_explicit_target_and_port_override_working_directory(self):
        with socket.socket() as sock:
            sock.bind(('0.0.0.0', 0))
            port = sock.getsockname()[1]
        result = subprocess.run([sys.executable, str(HELPER), '--source', str(self.source),
                                 '--target', str(self.target), '--port', str(port)],
                                cwd=self.root, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.target / '.wp-env.json').read_text())['port'], port)

    def test_single_site_does_not_invent_network_constants(self):
        for project in (self.source, self.target):
            config = json.loads((project / '.wp-env.json').read_text())
            config['multisite'] = False
            config['config'] = {}
            (project / '.wp-env.json').write_text(json.dumps(config))
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads((self.target / '.wp-env.json').read_text())
        self.assertNotIn('DOMAIN_CURRENT_SITE', config['config'])
        self.assertFalse(any('list' in call['args'] for call in self.calls()))
        self.assertEqual(sum(call['tool'] == 'curl' for call in self.calls()), 1)

    def test_existing_refuses_before_mutations(self):
        self.existing()
        before = self.tree(self.target)
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--replace-existing', result.stderr)
        self.assertEqual(self.tree(self.target), before)
        self.assertTrue(all(call['tool'] == 'wp-env' for call in self.calls()))

    def test_existing_backup_precedes_replacement_and_preserves_port(self):
        self.existing()
        result = self.invoke('--replace-existing')
        self.assertEqual(result.returncode, 0, result.stderr)
        snapshot = self.snapshot()
        self.assertEqual((snapshot / 'target-before.sql').read_text(), 'old target SQL\n')
        with tarfile.open(snapshot / 'target-wp-content.tar.gz') as archive:
            self.assertEqual(archive.extractfile('wp-content/uploads/media.jpg').read(), b'old target photo')
        self.assertEqual(json.loads((self.target / '.wp-env.json').read_text())['port'], 7777)
        self.assertEqual(json.loads((snapshot / 'target.wp-env.json').read_text()), self.config)
        self.assertEqual((self.target / '.wp-env-data/wp-content/uploads/media.jpg').read_bytes(), b'source photo\x00\xff')
        exports = [call for call in self.calls() if 'export' in call['args']]
        self.assertIn('target-install', exports[0]['args'][exports[0]['args'].index('--file') + 1])

    def test_import_failure_stops_before_replacement_or_http(self):
        result = self.invoke(fail='import')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.snapshot() / 'source.sql').exists())
        self.assertFalse(any('search-replace' in call['args'] or call['tool'] == 'curl' for call in self.calls()))

    def test_export_failure_leaves_target_configuration_and_content_alone(self):
        before = self.tree(self.target)
        result = self.invoke(fail='export')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.target / '.wp-env.json').read_bytes(), before['.wp-env.json'])
        self.assertFalse((self.target / '.wp-env-data/wp-content').exists())
        self.assertFalse(any(call['tool'] == 'npm' or 'import' in call['args'] for call in self.calls()))

    def test_startup_failure_stops_before_import(self):
        result = self.invoke(fail='startup')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.snapshot() / 'source.sql').exists())
        self.assertTrue(any(call['tool'] == 'npm' for call in self.calls()))
        self.assertFalse(any('import' in call['args'] for call in self.calls()))

    def test_url_failure_stops_before_cache_or_http(self):
        result = self.invoke(fail='urls')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any('search-replace' in call['args'] for call in self.calls()))
        self.assertFalse(any('flush' in call['args'] or call['tool'] == 'curl' for call in self.calls()))

    def test_http_failure_is_not_reported_as_success(self):
        result = self.invoke(fail='http')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(any(call['tool'] == 'curl' for call in self.calls()))
        self.assertNotIn('Clone ready:', result.stdout)

    def test_source_and_target_cannot_be_same(self):
        result = self.invoke('--target', str(self.source))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.tree(self.source), self.before_source)
        self.assertEqual(self.calls(), [])

    def test_occupied_port_refuses_before_writes(self):
        with socket.socket() as sock:
            sock.bind(('0.0.0.0', 0))
            result = self.invoke('--port', str(sock.getsockname()[1]))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.target / '.wp-env-data').exists())

    def test_overrides_and_core_mismatch_refuse_before_writes(self):
        override = self.target / '.wp-env.override.json'
        override.write_text('{}')
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        override.unlink()
        config = json.loads((self.target / '.wp-env.json').read_text())
        config['core'] = 'different-version'
        (self.target / '.wp-env.json').write_text(json.dumps(config))
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.target / '.wp-env-data').exists())
        self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
