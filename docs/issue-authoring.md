# Issue authoring

Guidance for **review findings filed as GitHub issues**. Implementation tasks,
questions, and umbrella issues can use a format that fits their purpose.

## Required sections for review findings

Omit a section when there is nothing concrete to say; do not pad.

### Finding

State what is wrong and cite the relevant `path:line` for code defects.

### Evidence

Give a minimal reproduction, a command and its output, or a precise code reference
that supports the finding. Distinguish verified behavior from assumptions.

### Next step

Give a short decision or pointer. Do not turn the issue into a full implementation
specification; implementation plans can be added later.

Optional sections: **Impact**, **Expected behavior**, and **Confidence**
(`high`, `medium`, or `low`). Put an independent re-check in a comment, not in
additional issue sections.

## Policy

- File one defect per issue. If multiple reviewers find the same defect, file it once.
- If it is unclear whether something is a defect, use the `question` label rather
  than `bug`.
- Use an existing label (`gh label list`). For findings, use the `bug` label when
  appropriate and include `path:line` in the body.
- Do not report vulnerabilities in public issues. Use GitHub's private
  vulnerability-reporting channel when available, or contact the maintainer
  privately.
- Write issue bodies with `gh issue create --body-file` to preserve formatting.

Adapted from the [fwlive issue-authoring guide](https://github.com/lucas-albers-lz4/fwlive/blob/master/docs/developer/issue-authoring.md).

## Example

Title: `bug: unquoted expansion in helper script`

```markdown
## Finding
`scripts/foo.sh:42` — failure path echoes `$msg` unquoted.

## Evidence
Line 42: `echo $msg` (the expansion is unquoted).

## Next step
Quote the expansion and add a shellcheck check if one is missing.
```
