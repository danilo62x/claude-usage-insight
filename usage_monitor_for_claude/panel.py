"""
Session Panel
=============

Resizable window with the session table, the charts and the quota breakdown.

This is deliberately a *second* window rather than a bigger popup.  The tray
popup is anchored to the tray icon, sized from its own content and dismissed as
soon as it loses focus - all correct for a glance at the quota bars, all wrong
for a panel you park on a second monitor and click around in.  The popup keeps
its behaviour; this window is a floating, resizable one with no taskbar button
that remembers where you left it, with the live quota bars alongside the
breakdown rather than in a separate place.

Where the popup answers "how much of my quota is gone", this panel answers
"what spent it", by joining the API's real percentages with the local
transcript index.
"""
from __future__ import annotations

import json
import threading
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import webview  # type: ignore[import-untyped]  # no type stubs available

from . import __version__
from .claude_cli import find_installations
from .formatting import field_period, popup_label
from .i18n import T
from .instance_id import effective_config_dir
from .platforms.popup import PANEL_WINDOW_KWARGS, apply_panel_window_style, popup_url
from .sessions import index, queries
from .settings import BG

_PANEL_DIR = Path(__file__).parent / 'panel'
_STATE_FILENAME = 'usage-monitor-panel.json'

# Kept off the validated settings file on purpose: geometry is state the window
# writes on every move, not configuration a user edits, and mixing the two would
# make the settings file churn.
_DEFAULT_GEOMETRY = {'width': 1100, 'height': 720, 'x': None, 'y': None}
_MIN_SIZE = (760, 520)

__all__ = ['UsagePanel']

if TYPE_CHECKING:
    from .app import UsageMonitorForClaude


def _state_path() -> Path:
    """Return the panel state file for the config directory in effect."""
    return effective_config_dir() / _STATE_FILENAME


def load_geometry() -> dict[str, Any]:
    """Return the stored window geometry, falling back to the defaults.

    A corrupt or partial file is treated as absent: the panel is not worth
    failing to open over a bad remembered size.
    """
    geometry = dict(_DEFAULT_GEOMETRY)
    try:
        stored = json.loads(_state_path().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return geometry

    if not isinstance(stored, dict):
        return geometry

    for key in ('width', 'height', 'x', 'y'):
        value = stored.get(key)
        if isinstance(value, (int, float)):
            geometry[key] = int(value)

    geometry['width'] = max(_MIN_SIZE[0], int(geometry['width']))
    geometry['height'] = max(_MIN_SIZE[1], int(geometry['height']))
    return geometry


def save_geometry(geometry: dict[str, Any]) -> None:
    """Persist the window geometry, ignoring write failures.

    Losing the remembered position is a cosmetic problem; raising here would
    take down the bridge thread that reported it.
    """
    try:
        _state_path().write_text(json.dumps(geometry, indent=2) + '\n', encoding='utf-8')
    except OSError:
        pass


def _reset_epoch(value: Any) -> float | None:
    """Return *value* as a Unix timestamp, accepting ISO strings or numbers."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        except ValueError:
            return None
    return None


class _PanelApi:
    """Bridge exposed to the panel's JavaScript as ``pywebview.api``.

    Every method is called on a fresh pywebview thread, so each one opens its
    own SQLite connection rather than sharing a handle.
    """

    def __init__(self, panel: UsagePanel) -> None:
        self._panel = panel

    # -- data ---------------------------------------------------------------

    def refresh(self, min_interval: float = 0) -> dict[str, Any]:
        """Re-index the transcripts and report how long it took."""
        return index.refresh(min_interval=min_interval)

    def sessions(self, since: str | None = None, until: str | None = None,
                 tz_offset_minutes: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        """Return the session table rows."""
        conn = index.connect()
        try:
            return queries.sessions(conn, since=since, until=until,
                                    tz_offset_minutes=tz_offset_minutes, limit=limit)
        finally:
            conn.close()

    def charts(self, days: int = 30, tz_offset_minutes: int = 0) -> dict[str, Any]:
        """Return every dataset the charts tab draws, in one round trip."""
        conn = index.connect()
        try:
            return {
                'daily': queries.daily(conn, days=days, tz_offset_minutes=tz_offset_minutes),
                'by_model': queries.by_model(conn, days=days, tz_offset_minutes=tz_offset_minutes),
                'hourly': queries.hourly(conn, days=days, tz_offset_minutes=tz_offset_minutes),
                'by_project': queries.by_project(conn, days=days, tz_offset_minutes=tz_offset_minutes),
            }
        finally:
            conn.close()

    def usage(self) -> dict[str, Any]:
        """Return the live quota windows and the detected Claude installations.

        Feeds the sidebar, which is the same data the tray popup shows: the
        percentages come from the API and are never estimated here.
        """
        snapshot = self._panel.app.cache.snapshot
        windows = []
        for field, data in (snapshot.usage or {}).items():
            if not isinstance(data, dict) or data.get('utilization') is None:
                continue
            period = field_period(field)
            resets_at = _reset_epoch(data.get('resets_at'))
            if not period or resets_at is None:
                continue
            windows.append({
                'field': field,
                'label': popup_label(field),
                'utilization': float(data.get('utilization') or 0),
                'resets_at': resets_at,
                'hours': period / 3600,
            })
        windows.sort(key=lambda w: w['hours'])

        versions = [{'name': i.name, 'version': i.version} for i in find_installations()]
        return {'windows': windows, 'versions': versions}

    def insights(self, days: int = 7, tz_offset_minutes: int = 0) -> dict[str, Any]:
        """Return the shares that explain where the weighted cost went."""
        conn = index.connect()
        try:
            return queries.insights(conn, days=days, tz_offset_minutes=tz_offset_minutes)
        finally:
            conn.close()

    def cost_curve(self, session_id: str, block: int = 25) -> list[dict[str, Any]]:
        """Return the per-turn cost curve for one session."""
        conn = index.connect()
        try:
            return queries.cost_curve(conn, session_id, block=block)
        finally:
            conn.close()

    def quotas(self) -> list[dict[str, Any]]:
        """Return each live quota window with the sessions that filled it.

        The percentage is the API's own number - the app never estimates it.
        The attribution underneath is local, and only covers windows whose span
        the transcripts actually reach back over.
        """
        snapshot = self._panel.app.cache.snapshot
        usage = snapshot.usage or {}
        out: list[dict[str, Any]] = []

        conn = index.connect()
        try:
            for field, data in usage.items():
                if not isinstance(data, dict) or data.get('utilization') is None:
                    continue
                period = field_period(field)
                resets_at = _reset_epoch(data.get('resets_at'))
                if not period or resets_at is None:
                    continue
                out.append({
                    'field': field,
                    'label': popup_label(field),
                    'utilization': float(data.get('utilization') or 0),
                    'resets_at': resets_at,
                    'hours': period / 3600,
                    'sessions': queries.quota_window(conn, hours=period / 3600,
                                                     resets_at=resets_at, limit=12),
                })
        finally:
            conn.close()

        out.sort(key=lambda w: w['hours'])
        return out

    # -- window -------------------------------------------------------------

    def report_geometry(self, width: int, height: int, x: int, y: int) -> None:
        """Store the window geometry reported by the page."""
        save_geometry({'width': int(width), 'height': int(height), 'x': int(x), 'y': int(y)})

    def open_url(self, url: str) -> None:
        """Open *url* in the default browser."""
        if url.startswith(('http://', 'https://')):
            webbrowser.open(url)

    def close(self) -> None:
        """Close the panel."""
        self._panel.close()


class UsagePanel:
    """Resizable session panel.  One instance at a time."""

    def __init__(self, app: UsageMonitorForClaude) -> None:
        """Create and show the panel, blocking until it is closed."""
        self.app = app
        self._closed = threading.Event()

        geometry = load_geometry()
        kwargs: dict[str, Any] = {
            'width': geometry['width'],
            'height': geometry['height'],
            'min_size': _MIN_SIZE,
            'background_color': BG,
            'js_api': _PanelApi(self),
            **PANEL_WINDOW_KWARGS,
        }
        if geometry['x'] is not None and geometry['y'] is not None:
            kwargs['x'] = geometry['x']
            kwargs['y'] = geometry['y']

        self._window = webview.create_window(
            T.get('panel_title', 'Usage Monitor - Sessions'),
            url=popup_url(_PANEL_DIR / 'panel.html'),
            **kwargs,
        )
        self._window.events.loaded += self._on_loaded
        self._window.events.closed += self._on_closed
        self._closed.wait()

    def _on_loaded(self) -> None:
        """Hand initialisation to a worker thread.

        Initialising inline would deadlock the GTK backend, which delivers this
        event on the same main loop that every pywebview call waits for.
        """
        threading.Thread(target=self._initialise, daemon=True).start()

    def _initialise(self) -> None:
        """Drop the taskbar button, then hand the labels to the page."""
        apply_panel_window_style(self._window)

        config = {
            'version': __version__,
            'strings': {key: T[key] for key in T if key.startswith('panel_')},
            'indexed': index.is_indexed(),
            'theme': 'dark',
        }
        self._window.evaluate_js(f'init({json.dumps(config)})')

    def _on_closed(self) -> None:
        """Release the thread blocked in ``__init__``."""
        self._closed.set()

    def close(self) -> None:
        """Destroy the window."""
        try:
            self._window.destroy()
        except Exception:  # noqa: BLE001 - the window may already be gone
            self._closed.set()
