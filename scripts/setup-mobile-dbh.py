"""Run through dbh-run exec to route the named mobile hostname to the dedicated development container."""
import datetime
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
from urllib.parse import urlparse


class MobileRoute:
    @staticmethod
    def run(profile):
        if profile not in ('n', 'd'):
            raise ValueError('Unknown dbh profile')
        metadata = tomllib.loads(Path('.codex/dbh-run.toml').read_text())
        url = urlparse(metadata['urls']['mobile'].format(profile=profile))
        if url.path not in ('', '/') or url.hostname != f'mobile.tr.{profile}.lan':
            raise ValueError('Expected the named mobile hostname')
        config = Path.home() / '.config/dbh-run/Caddyfile'
        before = config.read_text()
        app_host = urlparse(metadata['urls']['app'].format(profile=profile)).hostname
        legacy = f'''{app_host} {{
\t# TypeRelay mobile preview: {profile}
\ttls internal
\timport cors
\tencode gzip
\t@mobile path /mobile /mobile/*
\thandle @mobile {{
\t\treverse_proxy http://{profile}-typerelay-mobile:5174
\t}}
\thandle {{
\t\treverse_proxy http://{profile}-typerelay-server:3040
\t}}
}}'''
        original = f'{app_host} {{\n\timport dbh_web {profile}-typerelay-server 3040\n}}'
        after = before.replace(legacy, original)
        block = f'{url.hostname} {{\n\timport dbh_web {profile}-typerelay-mobile 5174\n}}'
        if block not in after:
            if url.hostname in after:
                raise ValueError('Mobile hostname already has a different Caddy route')
            after += '\n\n' + block + '\n'
        if after == before:
            print('Mobile Caddy route already configured')
            return
        backup = config.with_name('Caddyfile.before-mobile-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
        backup.write_text(before)
        # Keep the inode: the running development proxy bind-mounts this file.
        config.write_text(after)
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as control:
            json.dump({'services': {'caddy': {'image': 'caddy:2'}}}, control)
            control.flush()
            command = ['docker', 'compose', '-p', 'global', '-f', control.name, 'exec', '-T', 'caddy', 'caddy']
            try:
                subprocess.run(command + ['validate', '--config', '/etc/caddy/Caddyfile'], check=True, capture_output=True)
                subprocess.run(command + ['reload', '--config', '/etc/caddy/Caddyfile'], check=True, capture_output=True)
            except subprocess.CalledProcessError:
                config.write_text(before)
                raise
        print('Configured ' + metadata['urls']['mobile'].format(profile=profile))


if __name__ == '__main__':
    MobileRoute.run(sys.argv[1])
