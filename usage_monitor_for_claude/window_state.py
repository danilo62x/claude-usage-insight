"""
Window State
============

Remembers how the windows were left: the session panel's geometry and the
popup's view options.

Deliberately separate from :mod:`usage_monitor_for_claude.settings`.  That file
is configuration the user writes and the app only reads - a promise the README
and PRIVACY.md both make - while this is state the app writes on every drag and
toggle.  Mixing them would have the app rewriting a file the user is editing.

A read failure is never fatal: losing a remembered size or opacity is cosmetic,
and defaults are always a usable state.
"""
from __future__ import annotations

import json
from typing import Any

from .instance_id import effective_config_dir

STATE_FILENAME = 'usage-monitor-ui.json'

__all__ = ['STATE_FILENAME', 'load', 'update']


def _path() -> Any:
    """Return the state file for the config directory in effect."""
    return effective_config_dir() / STATE_FILENAME


def load() -> dict[str, Any]:
    """Return the stored state, or an empty dict when there is none."""
    try:
        stored = json.loads(_path().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}

    return stored if isinstance(stored, dict) else {}


def update(values: dict[str, Any]) -> None:
    """Merge *values* into the stored state.

    Merging rather than replacing is what lets the popup and the panel write
    their own keys without reading each other's, and what keeps a resize from
    dropping a flag the caller did not mention.
    """
    state = load()
    state.update(values)
    try:
        _path().write_text(json.dumps(state, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    except OSError:
        pass
