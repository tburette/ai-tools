#!/usr/bin/env python3
"""Clone local wp-env data without touching the checkout's application code."""

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit


PROGRESS_INTERVAL_SECONDS = 15


class CloneError(Exception):
    pass


def log(message):
    print(message, flush=True)


def run(command, cwd, capture=False, progress=None, **kwargs):
    if capture:
        kwargs['stdout'] = subprocess.PIPE
    finished = threading.Event()
    started = time.monotonic()

    def report_wait():
        while not finished.wait(PROGRESS_INTERVAL_SECONDS):
            elapsed = int(time.monotonic() - started)
            # Diagnostics must stay outside captured child output (SQL/JSON).
            print(f'{progress} still running ({elapsed}s elapsed).', file=sys.stderr, flush=True)

    reporter = threading.Thread(target=report_wait, daemon=True) if progress else None
    if reporter:
        reporter.start()
    try:
        return subprocess.run([str(arg) for arg in command], cwd=cwd,
                              text=True, check=True, **kwargs).stdout
    finally:
        finished.set()
        if reporter:
            reporter.join()


def read_config(project):
    if not project.is_dir() or not (project / '.wp-env.json').is_file():
        raise CloneError(f'Not a wp-env checkout: {project}')
    if (project / '.wp-env.override.json').exists():
        raise CloneError(f'Review .wp-env.override.json in {project}; overrides are unsupported.')
    config = json.loads((project / '.wp-env.json').read_text())
    if 'env' in config or config.get('testsEnvironment') is not False:
        raise CloneError('Only a development environment with testsEnvironment: false is supported.')
    if config.get('mappings', {}).get('wp-content') != './.wp-env-data/wp-content':
        raise CloneError(f'{project} needs wp-content mapped to ./.wp-env-data/wp-content.')
    for path in (project / '.wp-env-data', project / '.wp-env-data/wp-content'):
        if path.is_symlink():
            raise CloneError(f'Content directories must not be symlinks: {path}')
    return config


def status(project):
    result = json.loads(run(['wp-env', 'status', '--json'], project, capture=True, timeout=30))
    if result.get('status') not in {'uninitialized', 'running', 'stopped'}:
        raise CloneError(f'Unexpected wp-env status in {project}: {result.get("status")}')
    if Path(result['configPath']).resolve() != project:
        raise CloneError(f'wp-env addressed a different checkout: {result["configPath"]}')
    if result['status'] == 'running' and result.get('runtime') != 'docker':
        raise CloneError('Only the Docker wp-env runtime is supported.')
    return result


def wp(environment, *args, url=None, skip=True):
    command = ['docker', 'compose', '--file',
               str(Path(environment['installPath']) / 'docker-compose.yml'),
               'exec', '-T', 'cli', 'wp', '--quiet']
    if url:
        command.append('--url=' + url)
    if skip:
        command += ['--skip-plugins', '--skip-themes']
    return command + list(args)


def choose_port(requested, forbidden, existing=None):
    if existing is not None:
        if requested is not None and requested != existing:
            raise CloneError('An existing target retains its port; omit --port or use its current port.')
        if existing == forbidden:
            raise CloneError('Source and target must use different ports.')
        return existing
    candidates = [requested] if requested is not None else secrets.SystemRandom().sample(range(9000, 10000), 1000)
    for port in candidates:
        if not 1 <= port <= 65535 or port == forbidden:
            continue
        with socket.socket() as sock:
            try:
                sock.bind(('0.0.0.0', port))
            except OSError:
                continue
        return port
    raise CloneError('The requested port is occupied/invalid/the source port, or no free port was found.')


def export_database(environment, project, destination):
    # SQL stays outside the website. A real file descriptor keeps input/output
    # streaming and avoids putting SQL or connection credentials in arguments.
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as sql:
        run(wp(environment, 'db', 'export', '-', '--single-transaction',
               '--quick', '--add-drop-table'), project, stdout=sql)


def clone(args):
    source, target = args.source.expanduser().resolve(), args.target.expanduser().resolve()
    if source == target or source.is_relative_to(target) or target.is_relative_to(source):
        raise CloneError('Source and target must be separate, non-nested checkouts.')
    source_config, target_config = read_config(source), read_config(target)
    for key in ('core', 'plugins', 'themes', 'multisite'):
        if source_config.get(key) != target_config.get(key):
            raise CloneError(f'Source and target {key} differ; review compatibility before cloning.')
    for key in ('MULTISITE', 'SUBDOMAIN_INSTALL'):
        if source_config.get('config', {}).get(key) != target_config.get('config', {}).get(key):
            raise CloneError(f'Source and target {key} differ; network topology must match.')
    if not (source / '.wp-env-data/wp-content').is_dir():
        raise CloneError('Source wp-content is missing.')
    package = json.loads((target / 'package.json').read_text())
    if not package.get('scripts', {}).get('start'):
        raise CloneError('Target needs an npm start script; do not bypass its startup checks.')
    for dependency in ('wp-env', 'docker', 'npm', 'rsync', 'curl'):
        if shutil.which(dependency) is None:
            raise CloneError(f'Missing prerequisite: {dependency}')
    source_state, target_state = status(source), status(target)
    if source_state['status'] != 'running':
        raise CloneError('Start the source with npm run start before cloning; do not provision.')
    if source_state['installPath'] == target_state['installPath']:
        raise CloneError('Source and target resolve to the same wp-env installation.')
    existing = target_state['status'] != 'uninitialized'
    if existing and not args.replace_existing:
        raise CloneError('Target already exists. Use --replace-existing only when replacement is authorized; it creates a recovery backup.')
    if existing and target_state['status'] != 'running':
        raise CloneError('Start the existing target with npm run start so it can be backed up before replacement.')
    source_url = source_state['urls']['development'].rstrip('/')
    parsed = urlsplit(source_url)
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or parsed.path:
        raise CloneError('Source must have a root HTTP(S) development URL without embedded credentials.')
    source_port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    existing_url = urlsplit(target_state['urls']['development']) if existing else None
    existing_port = (existing_url.port or (443 if existing_url.scheme == 'https' else 80)) if existing_url else None
    port = choose_port(args.port, source_port, existing_port)
    hostname = f'[{parsed.hostname}]' if ':' in parsed.hostname else parsed.hostname
    target_domain = f'{hostname}:{port}'
    target_url = urlunsplit((parsed.scheme, target_domain, '', '', ''))
    log(f'Source: {source}\nTarget: {target}\nURL: {target_url}')
    if args.dry_run:
        log('Preview only: no files, configuration, containers, or database records changed.')
        return

    data = target / '.wp-env-data'
    data.mkdir(exist_ok=True)
    prefix = 'clone-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-'
    snapshot = Path(tempfile.mkdtemp(prefix=prefix, dir=data))
    log(f'Snapshots: {snapshot}')
    shutil.copy2(target / '.wp-env.json', snapshot / 'target.wp-env.json')
    content = data / 'wp-content'
    if existing:
        log('Saving existing target database and wp-content before replacement...')
        export_database(target_state, target, snapshot / 'target-before.sql')
        with tarfile.open(snapshot / 'target-wp-content.tar.gz', 'w:gz', compresslevel=1) as archive:
            archive.add(content, arcname='wp-content')
    log('Exporting source database...')
    export_database(source_state, source, snapshot / 'source.sql')
    log('Copying wp-content...')
    content.mkdir(exist_ok=True)
    run(['rsync', '-a', '--no-owner', '--no-group',
         str(source / '.wp-env-data/wp-content') + '/', str(content) + '/'], target)
    # Startup wrappers require these folders even when the source has no media
    # or downloaded translations yet. Repository theme/plugin mounts stay intact.
    for directory in ('uploads', 'languages', 'plugins', 'themes'):
        (content / directory).mkdir(exist_ok=True)
    target_config['port'], target_config['autoPort'] = port, False
    constants = target_config.setdefault('config', {})
    constants.update(WP_SITEURL=target_url, WP_HOME=target_url)
    if source_config.get('multisite') or constants.get('MULTISITE'):
        constants['DOMAIN_CURRENT_SITE'] = target_domain
    (target / '.wp-env.json').write_text(json.dumps(target_config, indent=2, ensure_ascii=False) + '\n')
    log('Starting target with npm run start (no provisioning)...')
    run(['npm', 'run', 'start'], target, progress='WordPress startup')
    target_state = status(target)
    if target_state['status'] != 'running' or target_state['installPath'] == source_state['installPath']:
        raise CloneError('Target did not start as a separate Docker environment.')
    if target_state['urls']['development'].rstrip('/') != target_url:
        raise CloneError('Target runtime URL does not match its selected hostname/port; import stopped.')
    log('Importing database...')
    with (snapshot / 'source.sql').open('rb') as sql:
        run(wp(target_state, 'db', 'import', '-'), target, stdin=sql)
    log('Updating stored URLs and multisite domains...')
    # The imported database still knows the SOURCE URL at bootstrap time.
    # Match the base hostname plus port so farm subdomains change as well.
    run(wp(target_state, 'search-replace', parsed.netloc, target_domain,
           '--all-tables-with-prefix', '--precise', '--skip-columns=guid',
           '--report-changed-only', url=source_url), target)
    run(wp(target_state, 'cache', 'flush', url=target_url, skip=False), target)
    sites = json.loads(run(wp(target_state, 'site', 'list', '--fields=blog_id,url',
                             '--format=json', url=target_url), target, capture=True)) if target_config.get('multisite') or constants.get('MULTISITE') else [{'url': target_url}]
    if not sites:
        raise CloneError('No sites returned after import.')
    log('Checking sites...')
    for site in sites:
        url = site['url']
        address = urlsplit(url)
        if (address.scheme != parsed.scheme or address.port != port or not address.hostname
                or (address.hostname != parsed.hostname and not address.hostname.endswith('.' + parsed.hostname))):
            raise CloneError(f'Unsupported mapped domain or stale site URL: {url}')
        code = run(['curl', '--noproxy', '*', '--fail', '--silent', '--show-error',
                    '--max-time', '30', '--output', os.devnull, '--write-out', '%{http_code}', url],
                   target, capture=True).strip()
        log(f'{code} {url}')
        if code != '200':
            raise CloneError(f'Expected HTTP 200 from {url}, got {code}.')
    log(f'Clone ready: {target_url}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Running source checkout (the skill supplies its personal default).')
    parser.add_argument('--target', type=Path, default=Path.cwd(), help='Target checkout; default: current directory.')
    parser.add_argument('--port', type=int, help='Free target port; default: random 9000–9999 for a new environment.')
    parser.add_argument('--replace-existing', action='store_true', help='Authorize replacing an initialized target, saving recovery snapshots first.')
    parser.add_argument('--dry-run', action='store_true', help='Read-only preflight and plan; no clone or startup.')
    args = parser.parse_args()
    try:
        clone(args)
    except (CloneError, OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(f'Clone stopped: {error}\nKeep any printed snapshots; inspect the failed step before retrying. No automatic reset, restore, or provisioning was performed.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
