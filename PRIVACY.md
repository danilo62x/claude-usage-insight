# Privacy Policy

**Claude Usage Insight** is a local desktop application that monitors your Claude API usage.
It runs on Windows and Linux.

## Data Collection

This application does **not** collect, store, or transmit any personal data.

## Network Communication

The application communicates exclusively with `api.anthropic.com` to retrieve your current API usage
data and, when extra usage is enabled for your account, your prepaid credit balance. No other network
connections are made.

The server certificate is verified against the Windows certificate store, the same store your browser
uses. A proxy that your organization has installed with its own root certificate can therefore inspect
this connection, as it does in the browser. Windows performs this check itself, as it does for any other
application, and may download a missing certificate authority certificate in the process.

## Credentials

The application reads your existing Claude OAuth token from the local Claude CLI configuration file
(`~/.claude/.credentials.json`, the same path on both platforms). This token is:

- Used solely in HTTP Authorization headers to authenticate with the Anthropic API
- Never logged, stored elsewhere, copied, or transmitted to any third party

## Local Storage

Usage data from the API is kept in memory only and discarded when the application closes. An
optional settings file (`usage-monitor-settings.json`) is read-only. Two features store anything at
all - the session panel and the popup's view options - and only once you use them. The complete
list of what the application changes on your system follows - there is nothing else.

**On both systems** two files are written next to your Claude configuration, the first only after
you open the session panel from the tray menu:

- `<Claude config>/usage-monitor-sessions.db` - an index of your local Claude Code transcripts
  (`<Claude config>/projects`), used for the session table and the charts. It holds token counts,
  timestamps, project names, session topics and tool names taken from those transcripts. It never
  holds message content, and nothing in it is sent anywhere - it is a local cache you can delete at
  any time; the panel rebuilds it on the next open.
- `<Claude config>/usage-monitor-ui.json` - how you left the windows: the panel's size and
  position, and whether the popup is collapsed and how opaque it is.

**On Windows** no other files are written. Two values are written to the registry, both under
`HKEY_CURRENT_USER`:

- `Software\Classes\AppUserModelId\DaniloQuinelato.ClaudeUsageInsight` - the display name and icon
  shown in the header of the application's notifications. Re-registered on every start.
- `Software\Microsoft\Windows\CurrentVersion\Run` - the autostart entry. Written only when you
  enable autostart from the tray menu, removed when you disable it again.

**On Linux** the registry has no equivalent, so the same two concerns need files:

- `~/.config/autostart/usage-monitor-for-claude.desktop` - the autostart entry. Written only when
  you enable autostart from the tray menu, removed when you disable it again.
- `$XDG_RUNTIME_DIR/usage-monitor-for-claude.lock` - a lock file that prevents a second instance
  from running. It holds the process id and version, is created with owner-only permissions
  (`0600`), and lives in the session's runtime directory, which the system clears at logout.

Monitoring a second Claude account (`--config-dir`) adds a suffix to those names, so each account
gets its own entry.

## Claude Code Installation

When the OAuth token has expired, the application runs `claude update` so that the Claude Code CLI
renews the token in its own credentials file. As a side effect of that command, a newer Claude Code
version may be installed. No other software on your system is modified.

## Third-Party Services

The application does not integrate with any analytics, tracking, advertising, or telemetry services.

## Contact

For questions about this privacy policy, please open an issue at
https://github.com/danilo62x/claude-usage-insight/issues
