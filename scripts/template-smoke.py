#!/usr/bin/env python3
"""Live desktop check. Requires explicit user idle authorization and --live.

All snippets and application windows are disposable. Existing service/panel and
focus are restored in finally. Account snippets stay untouched; fixture outputs are temporary.
"""
import argparse
import http.server
import threading
import importlib.util
import json
import os
import pathlib
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import tty
import termios

spec = importlib.util.spec_from_file_location('desktop_smoke', pathlib.Path(__file__).with_name('desktop-smoke.py'))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class TemplateSmoke(desktop.Smoke):
    def __init__(self, binary_dir=None):
        super().__init__()
        self.binary_dir = binary_dir or self.root / 'target/templates/release'

    def wait(self, check, seconds=8):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            result = check()
            if result:
                return result
            time.sleep(.05)
        raise RuntimeError('Timed out waiting for disposable template fixture')

    def active(self):
        return json.loads(self.command('hyprctl', '-j', 'activewindow'))

    def keys(self, text, expected=None):
        active = expected or self.active()
        subprocess.run([str(self.binary_dir / 'examples/send_keys'), text, active['class'], active['address']], check=True, timeout=15)

    def panel_window(self, pid):
        return self.wait(lambda: next((window for window in json.loads(self.command('hyprctl', '-j', 'clients')) if window['pid'] == pid), None))

    def record(self, path):
        try:
            return path.read_text()
        except FileNotFoundError:
            return ''

    def terminal(self, output):
        state = termios.tcgetattr(sys.stdin)
        text = ''; pasted = False; escape = ''; enters = 0
        try:
            tty.setraw(sys.stdin.fileno()); sys.stdout.write('\x1b[?2004h'); sys.stdout.flush()
            while True:
                char = sys.stdin.read(1)
                if not char or char == '\x03': break
                if char == '\x1b' or escape:
                    escape += char
                    if escape == '\x1b[200~': pasted = True; escape = ''
                    elif escape == '\x1b[201~': pasted = False; escape = ''
                    elif len(escape) > 6: raise RuntimeError('Unexpected terminal control sequence')
                    continue
                if char in ('\r', '\n'):
                    if not pasted: enters += 1
                    char = '\n'
                text = text[:-1] if char in ('\x08', '\x7f') else text + char
                output.write_text(json.dumps({'text': text, 'enters': enters}))
        finally:
            sys.stdout.write('\x1b[?2004l'); sys.stdout.flush(); termios.tcsetattr(sys.stdin, termios.TCSADRAIN, state)

    @staticmethod
    def interrupted(*_):
        raise KeyboardInterrupt('Live check interrupted')

    def run_live(self, cursor_only=False, cursor_cases=None):
        signal.signal(signal.SIGTERM, self.interrupted)
        signal.signal(signal.SIGALRM, self.interrupted)
        signal.alarm(240)
        original = self.active().get('address')
        service = subprocess.run(['systemctl', '--user', 'is-active', 'typerelay'], capture_output=True).returncode == 0
        old_panel = pathlib.Path.home() / '.local/bin/typerelay-panel'
        panel_running = subprocess.run(['pgrep', '-x', 'typerelay-panel'], capture_output=True).returncode == 0
        engine = panel = server = None
        with tempfile.TemporaryDirectory(prefix='typerelay-template-live-') as temporary:
            root = pathlib.Path(temporary); config = root / 'config/typerelay'; snippets = config / 'snippets'; snippets.mkdir(parents=True)
            (snippets / 'test.yml').write_text('''matches:
- trigger: static
  replace: Static works.
- trigger: date
  type: template
  replace: 'date={{date}}'
  variables:
    date:
      timezone: utc
- trigger: ask
  type: template
  replace: 'Hi {{name}} {{name}}'
- trigger: action
  type: template
  replace: 'one{{key:enter}}two'
''')
            cursor_cases = cursor_cases or [('start', '', 'a' * 2808), ('middle', 'before\n😀', ('e\u0301 tail\n' * (40 if desktop.BrowserFixture.contenteditable else 1800))), ('end', 'a' * 12000, ''), ('cancel', '', 'a' * 12000)]
            with (snippets / 'test.yml').open('a') as fixtures:
                for trigger, before, after in cursor_cases:
                    fixtures.write('\n- trigger: ' + trigger + '\n  type: template\n  replace: ' + json.dumps(before + '{{cursor:here}}' + after) + '\n')
            (config / 'settings.yml').write_text("trigger_prefix: ','\nsync_url: ''\n")
            (config / 'panel.json').write_text(json.dumps({'shortcut': 'Ctrl+Shift+Comma', 'launch_at_login': False}))
            env = {**os.environ, 'TYPERELAY_DIAGNOSTIC': '1', 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'), 'XDG_CACHE_HOME': str(root / 'cache')}
            try:
                if service: self.command('systemctl', '--user', 'stop', 'typerelay')
                if panel_running: subprocess.run([str(old_panel), '--quit'], check=True, timeout=10); time.sleep(.8)
                engine_log = (root / 'engine.log').open('w+')
                engine = self.start(str(self.binary_dir / 'typerelay'), 'run', '--dir', str(snippets), env=env, stdout=engine_log, stderr=engine_log)
                time.sleep(1)
                if engine.poll() is not None: raise RuntimeError((root / 'engine.log').read_text())
                self.wait(lambda: 'Typerelay input ready:' in (root / 'engine.log').read_text(), seconds=15)
                if cursor_only:
                    browser_output = root / 'browser.txt'; desktop.BrowserFixture.output = browser_output
                    server = http.server.HTTPServer(('127.0.0.1', 0), desktop.BrowserFixture)
                    threading.Thread(target=server.serve_forever, daemon=True).start()
                    for trigger, before, after in cursor_cases:
                        browser_output.write_text('')
                        desktop.BrowserFixture.arrows = 0
                        direct_before = (root / 'engine.log').read_text().count('Cursor positioned directly')
                        browser = self.start('chromium', '--user-data-dir=' + str(root / ('browser-' + trigger)), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', *(['--disable-renderer-accessibility'] if trigger == 'cancel' else ['--force-renderer-accessibility']), '--ozone-platform=wayland', '--app=http://127.0.0.1:' + str(server.server_port), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        self.focus('TypeRelay Browser Test'); target = self.active()
                        self.keys('z' * (len(trigger) + 2), target)
                        with sqlite3.connect(snippets / 'typerelay.sqlite') as db:
                            record = next({**json.loads(row[0]), 'library': row[1]} for row in db.execute('SELECT data,library FROM snippets') if json.loads(row[0]).get('trigger') == trigger)
                        hit = {'id': record['id'], 'library': record['library'], 'revision': record['revision'], 'library_name': '', 'title': '', 'abbreviation': trigger, 'preview': ''}
                        request = json.dumps({'hit': hit, 'target': target['address'], 'created_ms': int(time.time() * 1000), 'erase': len(trigger) + 2}).encode()
                        with socket.socket(socket.AF_UNIX) as connection:
                            connection.settimeout(180)
                            connection.connect(os.environ['XDG_RUNTIME_DIR'] + '/typerelay-panel/engine.sock')
                            connection.sendall(struct.pack('<I', len(request)) + request)
                            if trigger == 'cancel':
                                self.wait(lambda: self.record(browser_output) == before + after)
                                interruption = self.start('chromium', '--user-data-dir=' + str(root / 'browser-interruption'), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--ozone-platform=wayland', '--app=http://127.0.0.1:' + str(server.server_port), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                                window = self.panel_window(interruption.pid)
                                self.command('hyprctl', 'eval', 'hl.dispatch(hl.dsp.focus({window=' + json.dumps('address:' + window['address']) + '}))')
                            reply = b''
                            while chunk := connection.recv(4096): reply += chunk
                        if trigger == 'cancel':
                            assert 'Err' in json.loads(reply), reply
                            assert engine.poll() is None
                            assert self.record(browser_output) == before + after
                            interruption.terminate(); interruption.wait(timeout=5)
                            browser.terminate(); browser.wait(timeout=5)
                            print('PASS: focus change cancels long cursor movement; service remains running', flush=True)
                            continue
                        assert json.loads(reply) == {'Ok': None}, reply
                        assert (root / 'engine.log').read_text().count('Cursor positioned directly') == direct_before + 1, (root / 'engine.log').read_text()
                        expected = before + 'x' + after
                        assert self.record(browser_output) == before + after, 'Browser altered pasted text'
                        self.keys('x', target)
                        try: self.wait(lambda: self.record(browser_output) == expected, seconds=10)
                        except Exception:
                            import difflib
                            actual = self.record(browser_output)
                            print('Cursor output lengths:', len(actual), len(expected), 'differences:', [op for op in difflib.SequenceMatcher(None, expected, actual, autojunk=False).get_opcodes() if op[0] != 'equal'], flush=True)
                            raise
                        assert desktop.BrowserFixture.arrows == 0, 'Direct cursor positioning emitted arrow keys'
                        print('PASS: direct cursor ' + trigger + ', suffix ' + str(len(after)) + ' code points, native insertion and typing at marker', flush=True)
                        browser.terminate(); browser.wait(timeout=5)
                    return
                output = root / 'gtk.txt'
                gtk = self.start(sys.executable, str(self.root / 'scripts/desktop-smoke.py'), '--fixture', 'gtk', '--output', str(output))
                self.focus('TypeRelay GTK Test'); target = self.active()
                self.keys(',ask ', target); self.wait(lambda: self.record(output) == ',ask ')
                print('PASS: missing panel leaves prompted abbreviation unchanged', flush=True)
                gtk.send_signal(signal.SIGUSR1); self.wait(lambda: self.record(output) == '')
                self.keys(',date next', target); self.wait(lambda: self.record(output).startswith('date=') and self.record(output).endswith('next'))
                print('PASS: built-in date expands and following typing is preserved', flush=True)
                # Clear the disposable target before testing prompts.
                gtk.send_signal(signal.SIGUSR1); self.wait(lambda: self.record(output) == '')
                panel_log = (root / 'panel.log').open('w+')
                panel = self.start(str(self.binary_dir / 'typerelay-panel'), '--background', env=env, stdout=panel_log, stderr=panel_log)
                time.sleep(1.5)
                if panel.poll() is not None: raise RuntimeError((root / 'panel.log').read_text())
                self.keys(',ask ', target); window = self.panel_window(panel.pid)
                self.wait(lambda: self.record(output) == '')
                terminal_output = root / 'terminal.json'
                self.start('foot', '--title=TypeRelay Template Terminal', sys.executable, str(self.root / 'scripts/template-smoke.py'), '--terminal', str(terminal_output))
                self.focus('TypeRelay Template Terminal'); self.keys(',static ')
                self.wait(lambda: self.record(terminal_output) and json.loads(self.record(terminal_output))['text'] == 'Static works.')
                self.command('hyprctl', 'eval', 'hl.dispatch(hl.dsp.focus({window=' + json.dumps('address:' + window['address']) + '}))')
                print('PASS: expansion continues in another app while a prompt is open', flush=True)
                self.keys('nitai', window)
                held = self.start(str(self.binary_dir / 'examples/send_keys'), '--ctrl-enter', window['class'], window['address'])
                time.sleep(1.0)
                if self.record(output): raise AssertionError('Inserted before modifiers were released')
                held.wait(timeout=5); self.wait(lambda: self.record(output) == 'Hi nitai nitai')
                print('PASS: repeated input, original focus and modifier release', flush=True)
                gtk.send_signal(signal.SIGUSR1); self.wait(lambda: self.record(output) == '')
                self.keys(',ask ', target); window = self.panel_window(panel.pid); self.keys('{{key:enter}}\n', window)
                self.wait(lambda: self.record(output) == 'Hi {{key:enter}} {{key:enter}}')
                print('PASS: entered action syntax stays literal', flush=True)
                gtk.send_signal(signal.SIGUSR1); self.wait(lambda: self.record(output) == '')
                self.keys(',ask ', target); window = self.panel_window(panel.pid); self.keys('\x1b', window)
                self.wait(lambda: self.record(output) == '')
                print('PASS: cancel inserts nothing and does not restore abbreviation', flush=True)
                self.keys(',action ', target); self.wait(lambda: self.record(output) == 'one\ntwo')
                print('PASS: text / Enter / text order in GTK editor', flush=True)
                self.focus('TypeRelay Template Terminal'); self.keys(',action ')
                self.wait(lambda: self.record(terminal_output) and json.loads(self.record(terminal_output)) == {'text': 'Static works.one\ntwo', 'enters': 1})
                print('PASS: terminal receives exactly one real Enter outside paste', flush=True)
                browser_output = root / 'browser.txt'; desktop.BrowserFixture.output = browser_output
                server = http.server.HTTPServer(('127.0.0.1', 0), desktop.BrowserFixture)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                self.start('chromium', '--user-data-dir=' + str(root / 'browser'), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--ozone-platform=wayland', '--app=http://127.0.0.1:' + str(server.server_port), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.focus('TypeRelay Browser Test'); self.keys(',action ')
                self.wait(lambda: self.record(browser_output) == 'one\ntwo')
                print('PASS: ordered insertion into browser textarea', flush=True)
                self.focus('TypeRelay GTK Test'); target = self.active(); gtk.send_signal(signal.SIGUSR1); self.wait(lambda: self.record(output) == '')
                self.keys(',ask ', target); window = self.panel_window(panel.pid)
                gtk.terminate(); gtk.wait(timeout=3)
                self.keys('nothing\n', window)
                self.wait(lambda: self.active().get('pid') == panel.pid)
                assert self.record(browser_output) == 'one\ntwo'
                assert json.loads(self.record(terminal_output))['text'] == 'Static works.one\ntwo'
                print('PASS: a removed original target never redirects insertion elsewhere', flush=True)
            except Exception:
                for name in ['engine.log', 'panel.log', 'gtk.txt', 'terminal.json']:
                    path = root / name
                    if path.exists(): print(name + ': length=' + str(len(path.read_text())) + ' x-index=' + str(path.read_text().find('x')) + '\n' + path.read_text()[-3000:], file=sys.stderr)
                raise
            finally:
                signal.alarm(0)
                if server: server.shutdown(); server.server_close()
                if panel and panel.poll() is None: panel.terminate(); panel.wait(timeout=8)
                if engine and engine.poll() is None: engine.send_signal(signal.SIGINT); engine.wait(timeout=8)
                for child in reversed(self.children):
                    if child.poll() is None:
                        child.terminate()
                        try: child.wait(timeout=3)
                        except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=3)
                if service: self.command('systemctl', '--user', 'start', 'typerelay')
                if panel_running: subprocess.Popen([str(old_panel), '--background'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                if original: self.command('hyprctl', 'eval', 'hl.dispatch(hl.dsp.focus({window=' + json.dumps('address:' + original) + '}))')
                print('Original service, panel and focus restored.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--live', action='store_true'); parser.add_argument('--terminal', type=pathlib.Path); parser.add_argument('--cursor-only', action='store_true'); parser.add_argument('--binary-dir', type=pathlib.Path); parser.add_argument('--contenteditable', action='store_true'); args = parser.parse_args()
    desktop.BrowserFixture.contenteditable = args.contenteditable
    if args.terminal: TemplateSmoke().terminal(args.terminal)
    elif args.live: TemplateSmoke(args.binary_dir).run_live(cursor_only=args.cursor_only)
    else: parser.error('Live testing requires explicit user authorization and --live')
