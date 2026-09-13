# Full-course student pilot implementation plan

**Goal:** Deliver a verified local student edition covering S01–S14, with twelve guided notebooks and the two authored optional practical protocols.

**Architecture:** Extend the existing course-owned v2 manifest and static reader assets. Keep the deterministic engine, explicit sharing, session conversation and isolated kernel unchanged unless installed evidence reveals a defect. Package versioned course inputs with the working application and give this edition a separate default study folder.

**Spec:** The user's full-course student delivery request, 2026-09-13. Teacher/author workflows are excluded. Work proceeds in the two specified clean local checkouts under the user's instruction to work autonomously.

**Starting inputs:** Platform `8f815e1`; course `776f64a`. Previous delivered wheel `098a9fcca59d2225fe1f0e64d29959e14616485d30e4b686659b0614b4138b54`; previous local release artifact `CourseWeave Student Pilot`. Existing student files must remain untouched.

## Constraints

- All active files, resolved runtimes, caches and test homes remain on nonsynced local storage.
- Preserve notebook cell identities, meaningful attempt/solution structure, stdlib-only execution and output-free source notebooks.
- S01–S12: reading → notebook prediction/attempt/observation → self-check; labs/videos optional.
- S13/S14 retain prerequisites and optional status. No invented notebook, human pilot, rebuild, elapsed delay or real-world completion.
- Assistant access follows authored activity policy; blocked unaided work grants neither provider calls nor sharing. Records come only from explicit student actions.
- Preserve prior release and study folder; test a distinct fresh default and separate disposable acceptance homes.
- Reuse unchanged platform evidence. Extend existing checks and report live-provider observations separately from synthetic contracts.

## Work and acceptance checklist

- [x] Read all later lesson/notebook/protocol material and current setup/acceptance code. Capture baseline protection hashes.
- [x] Extend `courseweave.json` with lesson-specific objectives, predictions, attempt/observation prompts, ordered hints and explanatory checks. Reuse original surfaces/cell IDs, combine the notebook route, retain optional lab references. Extend `tests/test_courseweave_manifest.py` and installed `scripts/verify_courseweave.py` around actual behavior and policy.
- [x] Extend `lessons/static_diagrams.py`, `render_diagrams.py` and `build.py` to all authored diagrams, including multiple diagrams in a lesson. Extend stale-render/static reader tests; regenerate and check local links/fragments. Fix reproduced notebook defects with focused regression coverage.
- [x] Represent S13 unaided audit and S14 cold acceptance/human pilot as observer activities; provide permitted preparation and later review with the same assistant. Document prerequisites and evidence-based student records in course guidance and study notes.
- [x] Update `scripts/student_pilot.py`, `build_student_release.py` and student README for a distinct full-course default and truthful release scope. Extend setup preservation tests before changing behavior.
- [x] Extend `scripts/verify_student_release.mjs` to all lessons, notebooks, native/guide checks, protocols, scope/sharing, deterministic records and navigation. Reuse process/kernel/cleanup helpers. Run focused source tests and freeze versioned release inputs.
- [x] Retain old release separately; install the final package from its actual launcher in isolated fresh homes. Inspect all rendered lesson diagrams and navigation, execute/save every notebook and reject all unhandled error outputs, exercise every guide check and native disclosure, and verify protocol restrictions.
- [x] Verify bounded actual gateway responses and current-lesson scope; separately verify synthetic payload isolation and blocked calls. Verify restart, export/reset, notebook preservation, owned-process shutdown and credential-free evidence.
- [x] Obtain bounded independent review of course/pilot changes, resolve material findings and rerun affected acceptance. Record a per-module coverage matrix and exact package/source hashes.
- [x] Recheck protected source/student/rollback inventory and final release hashes; hand off only verified results with launcher and README links.

The 3–5 hour estimate is a planning assumption. Any substantive overrun will be reported with its cause; elapsed time is not an acceptance criterion.

## Final implementation — 2026-09-13

- Course `585b45eb3186404b8445cae64126ab9929c22b87`; application and delivery source `f1134590cced78a6bd5202062178eba1f1edc0ae`. The Lab bundle fixes serialized navigation and early reader interaction. Python, Learn assets and runtime constraints match the earlier release. All twelve notebook cell contents/IDs remain preserved; S09/S10 only gained notebook-level kernel metadata.
- Course verification covered 24 focused tests; the final S11 text follow-up reran its twenty relevant lesson/manifest checks. The static build and local references pass. All 154 code cells in twelve disposable source notebooks executed without unhandled errors.
- Exact final launcher fresh setup/repeat preservation passed (one test, 27.46 seconds). The final installed adapter resolves 124 surfaces across fourteen modules, verifies 30 HTML scopes, twelve prediction gates/kernel metadata, three observer activities, both review attestation gates and all 105 options of 35 guided checks.
- The independent reviewer verified corrections for practical student-suite selection, explicit retained-scope labels, A/B/A queue behavior, the early native-link interaction window and S11 budget wording. The pointer regression was strengthened to hit an actual wrapped-anchor line; its old/new results prove the failure and repair.
- The previous release remains intact at `CourseWeave Student Pilot S01-S02 Rollback`. All seven files, 173 existing student course files and the prior state still match the protection snapshot. The real user's new full-course default remains uncreated.
- Bounded live S03/S11/S14 responses from the settled release passed substantive reading and independent review with exact current activity/path and explicit HTML/Markdown scope. Durable state was unchanged and real-key-inclusive credential scans and cleanup passed. This is text-only provider evidence, separate from synthetic UI contracts.
- The final installed journey passed all fourteen lessons, twelve native notebook executions/saves, 35 checks/105 options, 108 native links, optional protocol restrictions, a continuous conversation, explicit sharing, 36/36 deterministic synthetic progress, restart/export/reset and owned-process/credential cleanup. See `docs/pilot/full-course-acceptance.md` and `.pilot/full-course-receipt.json` for the final module matrix and artifact identities. Software checks do not claim a real rebuild, delayed audit, human pilot or learning outcome.
