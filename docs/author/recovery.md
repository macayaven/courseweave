# Author backup and recovery

Use **Backup and recovery** in the Projects area. These operations work on saved
private Author projects. Finish or discard unsaved editing before changing
projects or restoring a backup.

## Make a private backup

1. Open the project. Select any pending/rejected drafts, saved review reports and
   saved research reports to include.
2. Choose **Inspect backup selection**. Review the file count, byte count and
   included files. The interface lists the first 100 files; the archive inventory
   records every included path and SHA-256.
3. Enter a new `.tar` file in nonsynced local storage outside the project, then
   choose **Create reviewed backup**. Keep the displayed archive SHA-256 with it.

The core backup includes the saved course, the current source registry and its
referenced snapshots, original import receipts/snapshots, and applied changes
needed for provenance. Optional reports retain their human dispositions and
evidence metadata. The backup preserves authored notebook bytes; it does not
clear them as a Student export does.

The selection excludes application credential files, session conversation,
runtime environments, Student homes, preview files, exported packages and
incomplete operation journals. It does not collect old unreferenced source
snapshots. Deliberately authored or imported content remains content: keep
credentials out of those files. Backups are private, unencrypted author archives,
not Student handoffs. Source and course licenses still apply.

The supported format is an uncompressed Author backup version 1 containing a
schema-v2 course, up to 40,000 files and 2 GiB. Changed source bytes or decisions
invalidate the inspected selection; inspect again before saving. Existing
destination files are never replaced.

## Restore into a new project

1. Enter the backup file under **Restore a private Author backup**.
2. Choose **Inspect restore archive**. The application verifies all file hashes,
   the complete inventory, supported artifact structures and source references.
   Partial, incompatible, linked or ambiguous archive paths are rejected before
   creating the destination project.
3. Enter a new **Restored project ID**, then choose **Restore as new project**.

The new project opens automatically. Original course and notebook-cell identities
are retained. Source decisions and human review dispositions are retained in the
new project. Pending drafts and saved reports become stale; review the current
content and evidence before a new edit. Rejected changes remain rejected. Old
apply operations are not replayed. Existing projects and Student homes are never
overwritten.

If storage fails or the archive changes while files are being copied, the new
directory stays incomplete and cannot open as a successful project. Retain it
for inspection, correct the storage/input issue and restore to another new ID.
The original backup and existing working project remain available.

## Interrupted saves and exports

When an Author project reopens, prepared content operations reconcile from exact
before/after hashes. An unchanged original remains pending without a success
receipt. An exact saved candidate reconciles once to the same applied receipt.
An unrelated external edit stays intact and produces a conflict. A journal that
does not match its reviewed change fails closed; restore a verified backup into
a new project rather than editing receipts to invent a successful save.

Choose **Inspect interrupted exports** to review export recovery. If the final
archive matches its journal hash, its missing receipt can be recovered. If no
final archive exists, the attempt remains interrupted. A different destination
file is a conflict and stays untouched. **Remove this export’s staging files**
removes only the directory carrying that attempt’s ownership marker; it does not
delete the exported archive. Do not manually rename temporary files into a
successful handoff.

Generated Student bundles carry their own `release.json` completion marker. An
interrupted bundle without that marker cannot launch. Inspect its selected local
destination and use a new destination for another build. Student delivery and
Author backups are separate operations.

## Interrupted Student preview

The preview control channel stops its owned Student process when Author exits.
Candidate Jupyter also watches its supervisor’s OS parent relationship, so an
unexpected supervisor exit releases the course lock through Jupyter’s normal
shutdown path. No unrelated process is selected for shutdown.

After restarting Author, reload preview inputs. An interrupted preview is shown
with its retained files. **Stop Student preview** verifies the saved process
start identity before stopping any surviving recorded child. An identity
mismatch refuses the stop. Keep the test files or explicitly discard them after
the process has ended. Interrupted deletion reconciles from the saved discard
intent; it cannot turn a previously retained preview into an unrequested delete.

Notebook outputs already saved to disk survive a process crash. Unsaved browser
edits and session-only assistant conversation are not recovered by a backup.
For a retained preview’s normal manual relaunch, use its generated
`bundle/Start Course.command` with the same explicit `--home` study path, as
described in the [preview guide](preview.md). Provider access still requires an
explicit configuration choice; restore does not restore credentials.

Development checks and installed artifact receipts remain separate from final
release acceptance. See the [implementation plan](../superpowers/plans/2026-09-14-courseweave-author-edition.md)
for the remaining release gates.
