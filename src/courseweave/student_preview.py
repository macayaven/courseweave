"""Private preview process wrapper, runnable with either supported Student wheel.

The bundle supplies the canonical standalone setup implementation. The selected
installed LaunchSupervisor supplies all Student/API/Jupyter/kernel behavior.
The inherited socket is the only readiness/control channel; nothing logs tokens.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import signal
import socket
import sys
import threading
import time


def main():
    bundle, home, descriptor, identity = sys.argv[1:5]
    serving = sys.argv[5:] == ['--serve']
    channel = socket.socket(fileno=int(descriptor))
    os.set_inheritable(channel.fileno(), True)

    def parent_lifetime():
        try:
            channel.recv(1)  # Stop command or EOF when the owning Author exits.
        except OSError:
            pass
        if serving:
            os.kill(os.getpid(), signal.SIGTERM)
            time.sleep(18)
        # Setup descendants share this new session. A stuck Student supervisor
        # also gets a bounded fallback; no unrelated process group is selected.
        if os.getpgrp() == os.getpid():
            os.killpg(os.getpid(), signal.SIGKILL if serving else signal.SIGTERM)
        else:
            os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=parent_lifetime, daemon=True).start()
    module = runpy.run_path(str(Path(bundle) / 'student_pilot.py'), run_name='preview_setup')
    if not serving:
        result = module['main'](['setup', '--home', home], root=Path(bundle))
        if result:
            return result
        data = module['load_release'](Path(bundle))
        _, platform, _ = module['runtime_paths'](data, Path(home))
        os.execve(str(platform), [str(platform), '-I', str(Path(__file__).absolute()),
            bundle, home, str(channel.fileno()), identity, '--serve'], dict(os.environ))
    from courseweave import __version__
    from courseweave.launch import LaunchSupervisor

    data = module['load_release'](Path(bundle))
    _, _, kernel = module['runtime_paths'](data, Path(home))
    supervisor = None

    def ready(url):
        channel.sendall((json.dumps({'url': url, 'student_version': __version__,
            'api_port': supervisor._listener.getsockname()[1]}) + '\n').encode())
        return True

    supervisor = LaunchSupervisor(Path(home) / 'course', state_dir=Path(home) / 'state',
        kernel_python=kernel, port=0, mode='learn', browser_opener=ready)
    try:
        return supervisor.run()
    finally:
        channel.close()


if __name__ == '__main__':
    raise SystemExit(main())
