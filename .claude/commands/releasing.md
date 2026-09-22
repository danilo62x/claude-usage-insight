---
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
description: Cut a new release - verify the tree, bump the version, roll the changelog, build and verify the EXE, and prepare the GitHub release commands
---

Prepare a release for version **$ARGUMENTS** (a semantic version like `1.21.0`). If no version was given, ask for it before doing anything.

Work through the steps **sequentially**, and **stop at the first failure** - a half-prepared release is worse than none. Respect the project git rule: **never commit, tag, or push** - this command edits files, builds the artifact and hands the final command sequence back to the user to run.

## Step 1: Preflight - do not touch a single file before this passes

Every check here failed at least once in a real release and cost the whole run. Run them first, in this order.

1. **Sync with the remote.** `git fetch origin`, then `git rev-list --left-right --count origin/main...HEAD`. Anything other than `0` on the left means the remote has commits you do not have: **stop**. Rolling the changelog on a stale tree produces a section that silently omits whatever was pushed meanwhile, and the tag would point at a tree without it. Report what is missing (`git log --oneline HEAD..origin/main`) and let the user decide how to integrate it.
2. **Clean working tree.** `git status --porcelain`. Uncommitted or untracked changes mean the tag would not describe what you built: **stop** and report them. (Untracked scratch files are the usual case - they belong in `.gitignore` or in the bin, and that is the user's call.)
3. **Tests green before any edit.** Activate the virtual environment, run `python -m unittest discover -s tests`. If the suite is already red, **stop** - the defect belongs to the branch, not to the release, and fixing it is a separate task the user must approve.

The suite must run **unattended**. If it blocks on a dialog, a prompt or a mysteriously long runtime, treat that as a defect to fix, not something to click away: a test that reaches a real Win32 dialog is also touching the real system.

## Step 2: Bump the version

Set the new version in **both** places (all fields must match exactly):

- `usage_monitor_for_claude/__init__.py` - `__version__`
- `version_info.py` - all four fields: `filevers`, `prodvers`, `FileVersion`, `ProductVersion`

`filevers`/`prodvers` are tuples (e.g. `(1, 21, 0, 0)`); `FileVersion`/`ProductVersion` are strings (e.g. `'1.21.0.0'`). Read both files first to match their existing shape, then edit.

## Step 3: Roll the changelog

In `CHANGELOG.md`:

- Rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` (today's date).
- Add a fresh, empty `## [Unreleased]` section **above** it, carrying a compare link against `vX.Y.Z...HEAD`.
- The rolled section keeps its own link, now comparing the previous tag to `vX.Y.Z`.

Do not invent entries - the section must already hold the changes accumulated during the unreleased period. If it is empty or looks incomplete, stop and tell the user; use `/changelog` to add entries first.

## Step 4: Tests again

Run the suite once more, now against the bumped tree. Some tests assert the version.

## Step 5: Build the EXE and prove it is the new one

**Build it here** - never release an artifact you did not just produce. A `dist/ClaudeUsageInsight.exe` left over from an earlier run carries the previous version, or the right version built from a tree that has since changed, and nothing about the file says so.

1. `python build.py` (virtual environment activated). **The run blocks partway through: the signing token asks for its PIN.** Tell the user before starting it and give the command a generous timeout - the wait otherwise reads as a hung build. A failed or unverifiable signature stops the build on its own, so a build that finishes is a signed build.
2. **Verify the version came from this build:** read it back out of the artifact and compare against the release version - this is the check that catches a stale EXE:
   ```powershell
   (Get-Item dist\ClaudeUsageInsight.exe).VersionInfo | Select-Object FileVersion, ProductVersion
   ```
   Both must read `X.Y.Z.0`. If they do not, the build did not run or picked up the wrong `version_info.py`: **stop**.
3. **Smoke-test it.** The unit tests never load the frozen bundle, so a missing `datas` entry or a hidden import only shows up here. First check that no instance is running (`Get-Process ClaudeUsageInsight`) - otherwise the single-instance dialog interrupts the user - then start it, confirm it is still alive a few seconds later, and stop it again. A process that exited on its own means a broken bundle: **stop** and report the exit code.

## Step 6: Write the release notes

The notes must carry the **exact** content of the new version's `CHANGELOG.md` section (the `### Added` / `### Changed` / `### Fixed` / `### Removed` blocks), followed by a `[Full changelog](<compare-url>)` link and a `[README for this version](https://github.com/danilo62x/claude-usage-insight/blob/vX.Y.Z/README.md)` link.

**Extract that section programmatically** - slice the file between the new version's heading and the previous one, and drop its `[Show all code changes]` line. Do not retype the entries: they are long, and a hand-copied release note that drifts from the changelog is not detectable by review.

Write them to a file and pass it with `--notes-file`, never inline via `--notes "..."`. The entries contain backticks, which PowerShell treats as escape characters inside double quotes and which would mangle the published notes.

The notes end with the SHA256 of the published EXE, which is what lets a reporter check an antivirus warning against the file actually published here. The hash is appended by the command below rather than written into the file, so it is always the hash of the artifact being uploaded - never reuse a hash from a previous release, and never append it twice.

## Step 7: Hand over the publish sequence

The release publishes a tag, which the git rule forbids this command from doing. **Output** the full sequence for the user, in this order - the commit must land *before* the tag, or the tag points at a tree without the version bump:

```powershell
git add CHANGELOG.md usage_monitor_for_claude/__init__.py version_info.py
git commit -m "chore: release vX.Y.Z"
git push origin main
"`n**SHA256 of ClaudeUsageInsight.exe:** $((Get-FileHash dist/ClaudeUsageInsight.exe -Algorithm SHA256).Hash)" | Add-Content <notes-file>
gh release create vX.Y.Z dist/ClaudeUsageInsight.exe --title "vX.Y.Z" --notes-file <notes-file>
```

Match the commit message to the project's history (`chore: release vX.Y.Z`).

## Summary

Report:
1. Preflight result - in sync with `origin/main`, clean tree, tests green.
2. Which files were edited and the old -> new version.
3. Confirmation that the changelog was rolled and the compare links updated.
4. Test result after the bump.
5. Build result: the `FileVersion` read back from the artifact and the smoke-test outcome.
6. The ready-to-run publish sequence.

Do not commit the version bump - the sequence in Step 7 is the user's to run.
