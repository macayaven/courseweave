# Security policy

## Supported versions

| Version | Status |
| --- | --- |
| Unreleased schema-v2 candidate | Receives current fixes; not a public distribution |
| 0.1.x | Historical public release; incompatible with schema-v2 courses |

Release support will be updated when a distinct schema-v2 artifact is published.

## Reporting a vulnerability

GitHub private vulnerability reporting is currently disabled for this repository.
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

The accepted local pilot does not establish general production hardening or
external compliance. Notebook transport was observed on loopback TCP with
HMAC-SHA256 authentication; payload encryption is not claimed. Upstream provider
or gateway logs have their own retention policy, separate from CourseWeave state
reset/delete behavior.
