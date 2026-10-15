"""Persistent scratch storage shared by API processes and workers.

Read at allocation time: changing settings never moves or removes an active
operation's files. Atomic project writes and resumable checkpoints stay beside
their destinations; this module only selects disposable working storage.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class TempStorageSettings(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    directory: str = Field(default='', max_length=4096)


class TempStorageError(ValueError):
    pass


def settings_path() -> Path:
    from backend.core.path_utils import get_data_directory
    return get_data_directory() / 'temporary-storage.json'


def load_settings() -> TempStorageSettings:
    path = settings_path()
    return TempStorageSettings.model_validate_json(path.read_text(encoding='utf-8')) if path.exists() else TempStorageSettings()


def default_directory() -> Path:
    from backend.core.path_utils import get_data_directory
    return (get_data_directory() / 'temp').resolve()


def _selected_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute() or '\x00' in value:
        raise TempStorageError('invalid_path')
    try:
        return path.resolve()
    except (OSError, ValueError, RuntimeError) as exc:
        raise TempStorageError('invalid_path') from exc


def effective_directory(settings: TempStorageSettings) -> Path:
    # A dedicated child prevents legacy cleanup routines from touching unrelated
    # files in the user-selected folder, even if they choose an entire drive.
    return _selected_path(settings.directory) / 'AutoClipTemp' if settings.directory else default_directory()


def get_directory() -> Path:
    directory = effective_directory(load_settings())
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def status(settings: TempStorageSettings | None = None) -> dict:
    settings = settings if settings is not None else load_settings()
    directory = effective_directory(settings)
    result = {
        'directory': settings.directory,
        'effective_directory': str(directory),
        'default_directory': str(default_directory()),
        'available': False,
        'free_bytes': None,
    }
    try:
        directory.mkdir(parents=True, exist_ok=True)
        result.update(available=True, free_bytes=shutil.disk_usage(directory).free)
    except OSError:
        pass  # Keep the editor usable when a saved external drive is unavailable.
    return result


def save_settings(settings: TempStorageSettings) -> dict:
    value = settings.directory.strip()
    settings = TempStorageSettings(directory=str(_selected_path(value)) if value else '')
    directory = effective_directory(settings)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=directory) as probe:
            probe.write(b'AutoClip storage check')
            probe.flush()
        shutil.disk_usage(directory)
    except OSError as exc:
        raise TempStorageError('directory_not_writable') from exc
    path = settings_path()
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_text(json.dumps(settings.model_dump(), ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return status(settings)


def upload_spool(*args, **kwargs):
    """Starlette's multipart factory, with a directory captured per uploaded file.

    Do not change tempfile.tempdir or TEMP/TMP: those are process-wide and can
    race with other requests, and would not update an already-running worker.
    """
    if kwargs.get('dir') is None:
        kwargs['dir'] = get_directory()
    return tempfile.SpooledTemporaryFile(*args, **kwargs)


def configure_upload_spooling() -> None:
    # Starlette creates UploadFile before endpoint handlers run and currently
    # offers no spool-directory setting. Only replace its allocation factory;
    # retain the real SpooledTemporaryFile class and parser size limits.
    from starlette import formparsers
    formparsers.SpooledTemporaryFile = upload_spool
