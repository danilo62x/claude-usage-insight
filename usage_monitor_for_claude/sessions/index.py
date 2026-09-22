"""Session index service: where the database lives and when it is rebuilt.

The tray app's own numbers come from the API and are authoritative for *how
much* of a quota is gone.  This index answers the complementary question -
*what* spent it - by reading the Claude Code transcripts on disk.

Indexing is incremental: a file whose mtime is unchanged is skipped, so a
refresh after the first run costs a fraction of a second even across a
multi-gigabyte transcript history.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from ..instance_id import effective_config_dir
from . import scanner

# One refresh at a time.  The panel can ask for one while the periodic timer is
# already running, and SQLite would otherwise serialize them into a lock error
# rather than a wait.
_refresh_lock = threading.Lock()
_last_refresh: float = 0.0


def db_path() -> Path:
    """Return the index database for the config directory in effect.

    Kept beside the Claude config rather than in a temp directory so it follows
    ``--config-dir``: monitoring a second account indexes that account's
    transcripts into its own database.
    """
    return effective_config_dir() / 'usage-monitor-sessions.db'


def projects_dirs() -> list[Path]:
    """Return the transcript directories to index."""
    return [effective_config_dir() / 'projects']


def connect() -> sqlite3.Connection:
    """Open a read-oriented connection to the index.

    Goes through the scanner's own ``get_db`` rather than ``sqlite3.connect``:
    it sets ``row_factory``, which the schema-migration helpers address columns
    by name through.

    pywebview dispatches every bridge call on a fresh thread, so each caller
    opens and closes its own connection inside that thread; none is ever shared
    across threads, which is why the default ``check_same_thread`` guard is left
    in place.
    """
    conn = scanner.get_db(db_path())
    scanner.init_db(conn)
    return conn


def _rebuild_if_schema_grew() -> None:
    """Force one full re-read when a column the panel needs was just added.

    An incremental scan skips files whose mtime is unchanged, and the turn rows
    it already wrote are protected by a unique index, so a new column would stay
    null for the entire history.  Clearing the derived tables costs one full
    pass (seconds) and nothing else: everything in them is rebuilt from the
    transcripts.
    """
    marker = 'fork_tool_arg_rebuilt'
    conn = connect()
    try:
        if scanner._meta_get(conn, marker):
            return
        conn.execute('DELETE FROM turns')
        conn.execute('DELETE FROM processed_files')
        scanner._meta_set(conn, marker, '1')
        conn.commit()
    except sqlite3.Error:
        return
    finally:
        conn.close()


def refresh(*, min_interval: float = 0.0) -> dict[str, Any]:
    """Bring the index up to date with the transcripts on disk.

    Parameters
    ----------
    min_interval : float
        Skip the scan when the previous one finished less than this many
        seconds ago.  The panel passes a small value so that clicking between
        tabs does not re-scan on every click.

    Returns
    -------
    dict
        ``elapsed`` in seconds, ``skipped`` when the interval suppressed it,
        and ``error`` with the message when the scan failed.
    """
    global _last_refresh

    if min_interval and time.time() - _last_refresh < min_interval:
        return {'elapsed': 0.0, 'skipped': True}

    with _refresh_lock:
        if min_interval and time.time() - _last_refresh < min_interval:
            return {'elapsed': 0.0, 'skipped': True}
        started = time.time()
        try:
            _rebuild_if_schema_grew()
            dirs = [d for d in projects_dirs() if d.is_dir()]
            scanner.scan(projects_dirs=dirs, db_path=db_path(), verbose=False)
        except Exception as exc:  # noqa: BLE001 - surfaced to the panel, never fatal
            return {'elapsed': time.time() - started, 'error': str(exc)}
        _last_refresh = time.time()
        return {'elapsed': _last_refresh - started, 'skipped': False}


def is_indexed() -> bool:
    """Return True once the index database exists and holds at least one turn."""
    if not db_path().exists():
        return False
    try:
        conn = sqlite3.connect(db_path())
        try:
            return bool(conn.execute('SELECT 1 FROM turns LIMIT 1').fetchone())
        finally:
            conn.close()
    except sqlite3.Error:
        return False
