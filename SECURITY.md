# Security policy

## Supported versions

| Version | Status |
| --- | --- |
| 0.3.0 Author and Student | Locally accepted; publication status and supported artifacts are in the v0.3.0 release record |
| 0.2.0 Student | Released schema-v2 application; current fixes are developed on the candidate branch |
| 0.1.x | Historical public release; incompatible with schema-v2 courses |

The release record identifies the exact distributed artifact and supported scope.

## Reporting a vulnerability

Email the maintainer at [macayaven@gmail.com](mailto:macayaven@gmail.com) with a
clear subject such as `CourseWeave security report`. Do not include credentials,
real learner records, private course material, or raw provider transcripts.
Include the affected version or commit, supported operating system and
Python/Jupyter versions, a minimal reproduction using synthetic data, the
observed impact, and any suggested mitigation.

Do not open a public issue for a vulnerability that could expose credentials,
bypass local capability checks, read undeclared workspace files, mutate course or
learner state without consent, escape path/symlink confinement, replay retired
authority, or leave owned processes/data behind after shutdown.

Security reports are assessed against CourseWeave's stated local operating scope.
Provider retention, course content, and vulnerabilities in an independently
installed course or model gateway may need to be reported to their respective
maintainers.

## Security model and current limits

CourseWeave binds its service to loopback, uses a per-launch capability token,
keeps provider credentials out of the course kernel, constrains declared reader
paths, and applies revision/idempotency checks to durable state and proposals.
Provider use is optional and must be configured explicitly.

Author source discovery/fetch is explicitly selected, bounded and network-off by
default. Source approval does not grant redistribution rights. Model replies have
no direct mutation authority: saved changes require review and revision checks.
Author backups exclude credential custody, chat and Student work; restores create
a new project with stale drafts/reports. Explicitly authored or imported content
can itself contain private information, so inspect selected files before sharing.

The accepted local pilot does not establish general production hardening or
external compliance. Notebook transport was observed on loopback TCP with
HMAC-SHA256 authentication; payload encryption is not claimed. Upstream provider
or gateway logs have their own retention policy, separate from CourseWeave state
reset/delete behavior.
