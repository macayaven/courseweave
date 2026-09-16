# Future ChatGPT interfaces for CourseWeave

**Date checked:** 2026-09-14. **Status:** Research and architectural recommendation; no integration built, installed, or tested. This note informs the [Author Edition plan](../plans/2026-09-14-courseweave-author-edition.md), and does not change the [three product specifications](../../specs/README.md).

## Recommendation

Keep CourseWeave's backend and course package as the authoritative product. A future ChatGPT-facing teacher/author helper or student study companion is feasible in principle, but custom GPTs are a poor new foundation now. Evaluate a supported plugin/app interface later, with separate account, permission, privacy, and acceptance checks.

## Current OpenAI documentation changes the decision

OpenAI's retirement FAQ says custom GPTs are being phased out across ChatGPT plans. Its detailed Enterprise schedule gives a September 17, 2026 migration target, a planned September 25 cutoff for new GPT creation, and December 11 retirement. Dates and account-specific availability can vary. Existing GPTs remain usable until their applicable retirement. The FAQ says custom actions do not migrate automatically and need reassessment/rebuilding through supported integrations. These are current documented plans, not an observation of this user's account. [Retirement and migration FAQ](https://help.openai.com/en/articles/20001519)

Custom GPTs combine instructions, knowledge files, and selected capabilities. Their knowledge files provide reference material; they do not replace behavioral instructions or course validation. OpenAI recommends clear source formatting and testing citations and use of uploaded material. [Creating and editing GPTs](https://help.openai.com/en/articles/8554397)

GPTs operate within ChatGPT and are not an embeddable external product interface. They do not carry saved memory or previous conversations across new chats. External integrations can send relevant inputs to their connected service, and data handling depends on the account and integration. [GPTs in ChatGPT](https://help.openai.com/en/articles/8554407)

Plugins can package reusable instructions and connected tools, but availability and access depend on surface, account, workspace, and underlying app permissions. A local plugin declaring an MCP server can be desktop-only; a remote URL in that declaration does not itself establish ChatGPT web support. [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256)

## Proposed future division of responsibilities

| Function | Potential ChatGPT interface | CourseWeave responsibility |
| --- | --- | --- |
| Author drafting and source critique | Invoke an authoring skill and request a draft/review | Bind sources and target revisions; validate candidate artifacts; preserve review decisions |
| Course validation | Request a compatibility report and explain issues | Execute canonical deterministic validators; return evidence and exact package/profile identity |
| Apply author changes | Present a draft and link to the review UI | Require the human's explicit review decision through an authenticated transaction |
| Student questions during permitted study | Retrieve authorized activity context and explain material | Enforce access to backend data/tools, explicit sharing, current scope and bounded context |
| Progress, export and reset | Show authoritative facts and open the native action | Retain direct learner authority and durable state; do not accept model-authored completion |
| Notebook use | Explain selected shared code and open the native course | Preserve the actual notebook/kernel/files and human-controlled execution |
| Unaided assessment/protocol work | At most direct the student back to the unaided native activity | Use the native student route; an external general chat is not a controlled assessment environment |

These are design proposals. The platform's API/MCP capabilities would need implementation and real acceptance; existing local launch tokens must never be exposed publicly or reused as remote authentication.

## Why an adapter cannot claim full equivalence automatically

A backend can deny a source retrieval or mutation. That does not guarantee that an independently running ChatGPT model will refrain from answering from its own context or general knowledge. Therefore a plugin/GPT cannot inherit the current native application's **zero provider calls during an unaided phase** guarantee merely by calling the same backend.

Likewise, local notebook identity and execution, course installation, exact exports, recovery, explicit sharing, and deterministically bound progress need the CourseWeave application. Uploading all course files to a GPT is not a substitute for these mechanisms. Answer keys or private author material should not be loaded into a student-facing general knowledge collection.

The sensible first experiment is an author helper that generates reviewable artifacts and requests compatibility reports, followed by a clearly scoped student companion for permitted activities. It should not claim secure exams, mastery assessment, automatic student monitoring, or identical privacy boundaries.

## Entry criteria for a later experiment

- The core author/student release and stable authority boundaries are accepted.
- The intended users' ChatGPT account/surface supports the chosen plugin/app delivery path; a local Codex plugin is not assumed to be a web ChatGPT app.
- Authentication, project/course authorization, explicit data disclosure, revocation, request limits, and public exposure are designed and reviewed separately.
- Familiar prompts and adversarial cases compare the adapter against the native product, including role/scope errors, forbidden assistance, stale changes, source leakage, and failure recovery.
- Model/platform updates have a re-evaluation path. Product viability does not depend on GPT Store revenue or an assumed migration experience.

The current Author Edition implements none of this integration. Its small shared backend and exported course contract preserve the option without spending the first release's effort on it.
