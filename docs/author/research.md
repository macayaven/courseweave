# Author source research

The v0.3.0 candidate supports local reference files, explicit public URLs and one
optional Brave Search API connector. These are private Author features. The
Student assistant does not retrieve their URLs or inherit the search credential.

## Setup and a first run

Start a private Author home with `courseweave author --home /local/author-home`.
Use a nonsynced local path. In **Research and references**, import a selected
local file, or enter public URLs. Neither workflow requires a Brave account.

For discovery, supply `BRAVE_SEARCH_API_KEY` only to the Author backend process
through your existing protected environment/secret custody. CourseWeave does not
look up a machine credential store, ask a notebook for a key, or offer a browser
key field. Keep the key out of course files, source references, commands committed
to version control and learner kernels. The launcher gives Jupyter only its
existing allowlisted environment, which excludes this key and model credentials.
The UI shows only whether discovery is configured. The author owns the account
and is responsible for its usage and charges; no price or entitlement is assumed.

1. Enter allowed HTTPS origins, with optional path prefixes, one per line.
   For example, `https://docs.python.org/3/library` allows that path and its
   descendants on that exact origin. Or deliberately select **Public web**.
   Deny rules always take precedence. Review the displayed policy.
2. Enter up to two queries and explicitly enable network access. **Discover
   sources** sends those queries to Brave, retaining at most ten results. Each
   query allows 600 characters and 75 words. No returned pages are fetched.
3. Select up to five allowed results and choose **Use selected URLs**, or enter
   your own URLs. Review the current policy, enable network access and choose
   **Fetch entered URLs**. This does not repeat discovery queries.
4. Read the saved source excerpt and provenance. A fetched source starts as a
   candidate reference with redistribution undecided. Choose its human review
   status and save that decision. Approval makes it eligible for explicit
   permission in the Author assistant; it does not prove the source is true.
5. Select the assistant's **Source researcher** role and explicitly permit the
   approved references for that request. Inspect the context and omissions before
   Send. Model synthesis uses the existing configured text route and does not
   perform additional searches or fetches.

The connector uses Brave's documented Web Search endpoint
`https://api.search.brave.com/res/v1/web/search` with its own subscription header.
It retains the returned URL, title, snippet and actual retrieval time. Unknown
publication dates remain unknown; a relative result age is not a publication
date. See the [official Web Search API reference](https://api-dashboard.search.brave.com/api-reference/web/search/get).

## Bounds and unavailable sources

One research run may be active per Author home. Each run allows at most two
queries, ten retained results, five explicitly chosen fetches and sixty seconds
of research work. A fetch allows ten seconds, three redirects and two MiB of
decompressed content. DNS waits, socket activity and waiting to publish a source
under the course lock check the deadline and cancellation. Small local terminal
report writes finish afterward so completed work and failures remain inspectable.
Ordinary filesystem availability is still required to save evidence.

Only public HTTPS destinations on port 443 are supported. The service normalizes
the URL, applies policy at every redirect, validates every resolved address, and
connects to a selected numeric address with the original TLS hostname verified.
It does not inherit proxies, cookies or provider credentials. It makes no automatic
retry, recursive crawl, access bypass or background refresh. Cancellation and
browser disconnection stop subsequent research; earlier saved sources remain.
Network access resets to off after a run or a new panel session.

The static extractor supports plain text, Markdown and simple HTML. It excludes
scripts, forms, obvious hidden elements and non-text embedded resources; it does
not compute visual layout, execute code or retrieve linked resources. Login and
access-challenge pages are unavailable. Empty or JavaScript-only content and
complex document formats are explicitly unavailable or unsupported. These checks
are conservative, not a complete site classifier. UTF-8, ASCII, Latin-1 and
Windows-1252 are supported; invalid/other encodings require a supplied text extract.

Local files are bounded to eight MiB per attachment; text extraction and retained
UTF-8 text are bounded to two MiB. An unsupported attachment retains its original
private bytes and metadata. A supplied reviewed text extract has its own origin;
put the original document/page attribution in the extract and source review note.
No OCR, PDF layout interpretation or multimedia understanding is claimed.

## Source revisions, reports and reuse

Raw and extracted snapshots have separate hashes. Character offsets address the
retained extraction, with an exclusive end offset. They are not offsets into the
original HTML. The UI pages through 8,000 characters; model context is smaller,
currently at most 4,000 characters per permitted source within the shared request
budget. A located quote proves correspondence to that snapshot, not factual truth.

An explicit refetch/import of an unchanged origin and snapshot preserves its
human decision. Changed raw bytes, extracted text, extractor version or final URL
create a new source revision with candidate status and undecided redistribution.
Prior snapshots remain immutable. A new revision revokes old assistant context and
pending-change dependencies. Different origins retain separate identities even
when their bytes match. Rejected or stale sources cannot be permitted to the model.

Saved research reports retain the actual request/policy, returned URLs, fetch
statuses, timestamps and source revision references. They exclude response bodies;
raw source bytes stay in the private snapshot directory. Reports survive restart
and are listed twenty at a time, with a maximum of 500 per project. After an
interrupted browser response, reload these reports before making another explicit
request. Reaching a storage limit requires backing up/archiving the project; the
application never deletes old evidence automatically. A corrupt report or snapshot
requires restoring a verified backup; it is not replaced by a model summary.

Sources, reports and search credentials are Author state. Incorporating an approved
passage into a learner-facing lesson requires attribution and the ordinary reviewed
content-change flow. A URL added to `learning.sources` remains reference metadata;
the Student runtime does not fetch it. Generic packaging and installed acceptance
are separate release gates, described in the [implementation notes](implementation.md).
