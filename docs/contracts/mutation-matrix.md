# CourseWeave mutation matrix

| Target | Trigger | Origin | Preview | Concurrency | Durable audit |
|---|---|---|---|---|---|
| Ephemeral active context | Jupyter focus change | system observation | none; metadata only | `source_id` + sequence | no |
| Prediction | Learner submits prediction card | `student_requested` | exact text in card | state revision + idempotency key | yes |
| Reflection | Learner submits reflection card | `student_requested` | exact text in card | state revision + idempotency key | yes |
| Evidence receipt | Learner records path/result | `student_requested` | exact receipt | state revision + idempotency key | yes |
| Phase completion | Learner clicks complete/check | `student_requested` | completion evidence | state revision + idempotency key | yes |
| Time budget | Learner edits session budget | `student_requested` | selected duration | state revision + idempotency key | yes |
| Learner profile | Learner asks, or teacher suggests | direct request or `teacher_suggested` proposal | field-by-field patch | proposal revision + state revision | yes |
| Course manifest | Author saves draft, or accepts teacher proposal | direct request or `teacher_suggested` proposal | full validation and JSON diff | ETag + idempotency key | yes |
| Workspace text file | Learner asks, or accepts teacher proposal | direct request or `teacher_suggested` proposal | full unified diff | target hash + proposal revision + journal | yes |
| Notebook/source excerpt sharing | Learner clicks Share | `student_requested` transient action | exact excerpt and provider disclosure | one chat run ID | no content retained |
| Terminal command | Learner opens terminal and runs/copies command | learner-controlled external action | exact argv displayed | Jupyter terminal owns process | optional explicit receipt only |
| Provider/model selection | Learner changes session setting | `student_requested` session action | provider/model/base URL without key | current process session | no credential; optional non-secret setting |

Navigation, chat interpretation, model inference, detected ability, elapsed time,
and file existence never create profile claims or completion records by
themselves.

