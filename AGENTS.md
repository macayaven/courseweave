# Engineering direction

Simplicity is the north star. Build a dependable product whose behavior and
maintenance costs are understandable. Read [the engineering standard](docs/engineering.md)
before architectural or release changes.

- Prefer the smallest complete solution using existing components. Add a
  dependency, service, abstraction, or compatibility path only for a demonstrated
  current need. Remove superseded paths when it is safe to do so.
- Keep one authoritative model for course rules and durable state. Adapters and
  interfaces consume it; assistant output never acquires mutation authority.
- Favor cohesive modules, explicit control flow, and clear ownership. Refactor
  to reduce coupling or duplicated behavior, not merely to increase file count
  or satisfy an arbitrary size target.
- Prove important behavior through the real installed user path, including
  failure and recovery. Synthetic providers test contracts; they do not prove a
  live provider works. Test counts do not prove product quality or learning gains.
- Preserve explicit consent, atomic writes, revision checks, bounded requests,
  and safe credential custody. Do not trade away correctness for cosmetic brevity.
- Fix verified defects with focused regression coverage. Reuse existing checks;
  avoid tests that only restate implementation and broad reruns without a reason.
- State the supported operating scope and observed limitations honestly. A local
  pilot acceptance is not a general production-readiness or compliance claim.
- Keep setup and release instructions current. Changes should be reproducible
  from versioned inputs without undocumented machine state.
