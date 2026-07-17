---
name: vision-plan
description: Create Issue Flow decision and visual plan artifacts with separated lifecycle stages, structured review anchors, architecture diagrams, and plan-kit validation.
---

# Vision Plan

Use this skill to create or update Issue Flow review artifacts:

- `decision.html` for a pre-plan decision review page when the requirement has contradictions, ambiguous scope, or user choices that must be answered before a plan is generated.
- `plan/index.html` for a visual implementation plan.

The artifact is a review surface, not a document dump. It should help the user understand the proposal faster and help an implementation agent execute it correctly.

This skill is active only when the source issue has `feature:visual-plan:on`. Without that label, Issue Flow uses the Markdown Plan workflow and this skill must not replace it.

## Hard Rules

1. Start each artifact from its source data.
   - For a plan, write `plan/data/visual-brief.md` before HTML.
   - For a decision gate, write `decision/data/decision-data.json` before `decision.html`.
   - Treat it as the information architecture contract for the artifact.
   - Do not start by styling a page.

2. Separate source of truth from presentation.
   - Put plan entities, edges, states, constraints, invariants, risks, and validation scenarios in `plan/data/plan-data.json`.
   - Put unresolved questions, options, recommendations, criteria, and consequences in `decision/data/decision-data.json`.
   - Put plan layout in `plan/index.html`; put decision-gate layout in `decision.html`.
   - HTML must not invent facts that are absent from its artifact source data.
   - Every important visible object must use `data-ref` to point at the JSON object it represents.
   - Every object that should expose a direct hover comment action must also use `data-comment-scope`.
   - The `<script type="application/json" id="plan-data">...</script>` island must be a verbatim copy of the current artifact's source JSON.

3. Keep the decision gate and implementation plan as separate lifecycle stages.
   - First inspect the requirement for contradictions, ambiguous scope, incompatible constraints, and choices whose answer materially changes the solution.
   - A Decision is justified only by a real unresolved choice that cannot be answered from the issue, repository, comments, or existing conventions. Do not create a Decision merely because Visual Plan is enabled.
   - When such questions exist, create `decision.html` and stop at the decision review gate. Each question needs a recommended option, alternatives, criteria, and consequences.
   - Anchor each decision card with `data-ref="decisions.<id>"`. The engine supplies Approve and Discuss actions and submits the answers as a Decision review.
   - After the user answers the gate, treat those answers as settled inputs and generate `plan/index.html` from them. The plan should lead with the resulting solution, boundaries, implementation mechanism, and validation.
   - When no blocking question exists, generate the plan directly.
   - `decision.html` embeds `decision/data/decision-data.json` in a `<script type="application/json" id="plan-data">...</script>` island so review context can resolve the selected question.
   - Publish a decision with `issue-flow pr submit plan --artifact decision`; publishing keeps the Plan branch/MR open and sets `flow::clarify`.
   - Publish a plan with `issue-flow pr submit plan --artifact plan`; it updates the same Plan branch/MR and sets `plan::pending` plus `flow::approve`.
   - Issue Flow owns publication, review routing, approval state, and provider operations after these commands complete.
   - Decision approval posts an approved review comment on the open Plan MR and resumes the same Plan task. Continue on the existing Plan branch and update the same MR with the Plan artifact.
   - When generating the first Plan after Decision approval, delete `decision.html` and the `decision/` directory before committing. The Plan commit and eventual merge must not retain the superseded Decision artifact.
   - Plan approval advances the source issue to Build. Do not bypass the Issue Flow review page.

4. Use diagrams instead of prose when structure is the point.
   - If the text says who calls whom, who owns a business rule, who writes state, where data comes from, where the boundary is, how retries/callbacks flow, or which part cannot do something, draw it.
   - Cards and paragraphs may explain a diagram, but must not replace it.

5. Keep language shallow and obvious.
   - Prefer plain words over architecture jargon.
   - Name things by business action, responsibility, state, data, and user-visible behavior.
   - Label the plan for a normal reviewer: "系统边界", "请求路径", "谁写状态", "失败后怎么走", "如何验证".
   - Each section should answer one concrete question. If a sentence needs rereading, rewrite it.

## Brief Contract

`plan/data/visual-brief.md` must include these fixed field names because `plan-kit/check.mjs` verifies them:

```md
- **Core outcome**: What will be built, in one direct sentence?
- **Main contradiction**: What is the real tension or risk?
- **Primary visual model**: What is the main diagram/view?
- **Model justification**: Why this model reveals the risk better than prose?
- **Supporting views**: What secondary diagrams/tables close gaps?
- **Interaction model**: Static, path toggle, stepper, tabs, or none.
- **Must show / must avoid**: What must be visible, and what should not be included?
```

## Diagram Selection

Use architecture models as a selection guide, not as labels to show the user.

| Review question | Use this view | When to choose it |
| --- | --- | --- |
| What is inside this system, and what is outside? | System boundary diagram | Users, third-party services, external APIs, payments, storage, or trust boundaries matter. |
| Which services/apps/stores own the behavior? | Service/data-store architecture diagram | Most backend/platform plans need this first. It shows applications, data stores, responsibilities, and communication. |
| Which modules inside one service own business rules? | Internal responsibility diagram | Use only when module ownership affects the implementation or refactor risk. |
| What happens at runtime for this scenario? | Runtime flow / sequence / dynamic diagram | Use for callbacks, retries, queues, worker handoff, agent loops, and multi-step workflows. |
| What states can this object move through? | State machine / lifecycle diagram | Use for refunds, jobs, tasks, approvals, sync, retries, and failure recovery. |
| Where does data originate, transform, and persist? | Data flow / provenance diagram | Use for forms, extraction, agent outputs, imports, audit trails, and generated content. |
| Who owns each action across roles or systems? | Responsibility lane diagram | Use when humans, agents, services, or workers share a workflow. |
| Which paths are allowed, denied, blocked, or partial? | Path matrix | Use for permissions, policy, validation gates, fallback paths, and risk coverage. |
| What proves this plan works? | Validation matrix | Use in every plan. Each risk or invariant should have at least one validation row. |

For many software tasks, the right structure is:

1. A system or service/data-store architecture diagram to establish boundaries.
2. A runtime, state, or data-flow diagram to explain the mechanism.
3. A path matrix to expose branches, boundaries, and edge cases.
4. A validation matrix to close the loop.

## Decision Page Contract

`decision.html` is a decision form, not a preface to the Plan and not a workflow report.

Show only:

1. A short statement of the concrete choice that blocks the Plan.
2. One decision card per unresolved choice.
3. For each choice: the recommended option, credible alternatives, decision criteria, and consequences of each option.
4. Only the repository or requirement evidence needed to make that choice.

If removing a section would not change the reviewer's choice, remove it. If there is no unresolved choice after repository inspection, do not generate `decision.html`; generate the Plan directly.

### Decision Items

Each entry in `decision/data/decision-data.json` represents one item that requires a user response:

- Use `type: "choice"` when the user must select one option. Provide `options[]` and `recommendedOptionId`; the engine adds Select controls to the option elements.
- Use `type: "approval"` only when the unresolved item is an explicit yes/no confirmation; the engine adds Approve and Discuss controls to the decision element.
- Keep criteria, evidence, consequences, and explanatory content inside the decision item. They remain commentable content rather than separate response items.
- Anchor the decision container with `data-ref="decisions.<decision-id>"` and each choice with `data-ref="decisions.<decision-id>.options.<option-id>"`.

## Plan Page Shape

The following reading order applies only to `plan/index.html`:

1. **核心方案**: one-sentence outcome, main contradiction, chosen boundary, and recommended path.
2. **Architecture diagram**: parts, external systems, data stores, ownership, and calls.
3. **Mechanism diagram**: runtime flow, state machine, data flow, or responsibility lanes.
4. **Implementation details**: module ownership, contracts, state changes, and failure handling.
5. **Implementation handoff**: only the few facts an implementer needs next.
6. **Validation closure**: tests or checks mapped to risks, invariants, and user-visible behavior.

Keep simple tasks simple. If a bug fix has one part and one state change, use one small architecture sketch plus a path matrix; do not build a large framework diagram.

The engine provides the artifact table of contents. Keep major sections in normal document flow with concise headings; use a continuous, blog-like reading order so a directory entry always maps to visible content. Use in-artifact tabs only for genuine alternate modes, not as the primary way to divide a long plan.

## Commentable Item Contract

The engine injects direct comment controls; artifact authors should not hand-write comment buttons.

- Use `data-comment-scope="section"` on every major readable section and add a concise `data-comment-label` when the heading is long. These elements become the engine-provided table of contents and section-level comment targets.
- Use `data-comment-scope="item"` on cards, list items, lifecycle states, validation rows, and other standalone review objects.
- Use `data-comment-scope="cell"` only when a table cell has independent meaning; otherwise mark the row as the commentable item.
- Use `data-comment-scope="node"` on SVG or HTML diagram nodes that reviewers may question.
- Do not use hover comments for edges. If an edge needs review, represent the edge as a row/card or discuss it through the connected node or section.
- Decision objects in `decision.html` use `data-ref="decisions.<id>"`; the engine provides fixed Approve and Discuss actions for them.
- Prefer `data-ref` and `data-comment-scope` over plain `id`/`class`; classes are presentation hooks, not review identity.
- Before delivery, verify in the engine that hovering a section, row/card, and diagram node reveals Comment and that every visible directory entry scrolls to real content.

## Plan Data Shape

Use whatever keys fit the task, but prefer these stable collections:

```json
{
  "meta": {},
  "core": {},
  "constraints": [],
  "architecture": [],
  "entities": [],
  "edges": [],
  "states": [],
  "transitions": [],
  "paths": [],
  "invariants": [],
  "risks": [],
  "validation": []
}
```

Guidelines:

- `constraints[]` records settled requirements and boundaries that shape implementation.
- `validation[].refs` should point to the risk, path, invariant, or behavior it proves.
- Branching, merging, or looping topology should be represented as real edges, not prose.

## Shared Styles

The installer owns one fixed stylesheet at `.issue-flow/plan-kit/kit.css`.

- `decision.html` links it as `../../plan-kit/kit.css`.
- `plan/index.html` links it as `../../../plan-kit/kit.css`.
- Keep only artifact-specific CSS under the current issue directory.

## HTML Rules

- Use the shared `.issue-flow/plan-kit/kit.css` and `plan-kit/kit.js` when suitable.
- Use `plan-kit/diagram.mjs` for topology with branching, merging, loops, or dense edge labels.
- Static SVG is acceptable for small diagrams when it is clearer and all important nodes have `data-ref`.
- Do not put cards inside cards.
- Use stable dimensions for diagrams, grids, counters, toolbars, and repeated items.
- Avoid viewport-scaled font sizes.
- Use `letter-spacing: 0`.
- Text must not overlap, overflow buttons/cards, or hide diagram labels.

## Validation

Run the checker before reporting completion:

```bash
node .agentrix/plugins/issue-flow/skills/vision-plan/plan-kit/check.mjs <issue-or-example>/plan
```

Fix all failures. Treat warnings as real review risks unless there is a clear reason.

The checker verifies:

- `index.html` has a JSON data island.
- The island matches `data/plan-data.json`.
- `data-ref` values resolve.
- Major sections and reviewable items expose valid comment scopes.
- Risks and implementation behavior are closed by validation scenarios.
- Complex topology is not collapsed into prose.
- Basic readability and contrast rules hold.
