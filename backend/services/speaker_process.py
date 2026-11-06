"""One isolated local model process per long-video job, started only on a cache miss."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import time
import uuid

from backend.services import child_guard, long_audio


class SpeakerProcess:
    def __init__(self, command, *, env, log, timeout=1800):
        self.command, self.env, self.log, self.timeout = command, env, Path(log), timeout
        self.process = None
        self.stream = None
        self.owner = 'speaker-' + uuid.uuid4().hex

    def __enter__(self):
        return self

    def infer(self, audio, result, *, options=None):
        long_audio.checkpoint()
        if self.process is None:
            self.log.parent.mkdir(parents=True, exist_ok=True)
            self.stream = self.log.open('w', encoding='utf-8')
            self.process = subprocess.Popen(
                self.command, env=self.env, stdin=subprocess.PIPE, stdout=self.stream,
                stderr=subprocess.STDOUT, text=True, encoding='utf-8',
                **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}))
            child_guard.track(self.process, self.owner)
        result = Path(result)
        result.unlink(missing_ok=True)
        self.process.stdin.write(json.dumps({'audio': str(audio), 'result': str(result), **(options or {})}) + '\n')
        self.process.stdin.flush()
        started = time.monotonic()
        while not result.is_file():
            long_audio.checkpoint()
            if self.process.poll() is not None:
                raise ValueError('本地字幕分段处理失败；已完成的分段已保留，可重试继续')
            if time.monotonic() - started >= self.timeout:
                raise subprocess.TimeoutExpired(self.command, self.timeout)
            time.sleep(.1)
        long_audio.checkpoint()
        return json.loads(result.read_text(encoding='utf-8'))

    def __exit__(self, exc_type, exc, traceback):
        try:
            if self.process is not None:
                if self.process.stdin:
                    try:
                        self.process.stdin.close()
                    except OSError:
                        pass
                if exc_type is not None:
                    child_guard.kill(self.owner)
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child_guard.kill(self.owner)
                    if self.process.poll() is None:
                        self.process.kill()
                    self.process.wait(timeout=10)
        finally:
            if self.process is not None:
                child_guard.untrack(self.process)
            if self.stream is not None:
                self.stream.close()
