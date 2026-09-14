#!/usr/bin/env node
// Evidence gate — validates the `evidence-gate:v1` block in a pull request body.
//
// Why this exists: PR checklists on this repo are self-attested and nothing reads
// them. PRs #414, #417 and #425 all sat open with every "Test plan" box unchecked
// while CI was green — CI proves the code compiles, not that anyone exercised it.
// This script is the missing check: it reads the evidence block and fails when a
// step is unchecked, empty, still holding a template placeholder, or missing the
// one artifact that makes it verifiable by someone else.
//
// Usage:
//   PR_BODY="$(gh pr view 414 --json body --jq .body)" node .github/scripts/evidence-gate.mjs
//   node .github/scripts/evidence-gate.mjs --selftest
//   node .github/scripts/evidence-gate.mjs --file /path/to/body.md
//   node .github/scripts/evidence-gate.mjs --file body.md --json   # machine-readable verdict
//
// The --json mode exists so an agent loop can use this as its stop condition. The
// same rules then judge a human PR and an agent's delivery, and neither grades its
// own homework: the verdict comes from code that cannot be talked out of it.
//
// Exit codes: 0 = pass (or warn mode), 1 = violations in enforce mode, 2 = bad usage.

const MARKER = '<!-- evidence-gate:v1 -->';
const END_MARKER = '<!-- /evidence-gate -->';

/** The steps the gate reads, in order. `waivable: false` means there is no escape hatch. */
const STEPS = [
  {
    key: 'task',
    label: 'Linked task',
    waivable: false,
    hint: 'Paste the ClickUp task URL (https://app.clickup.com/t/<id>). Every change traces to a card.',
    check: (v) =>
      /app\.clickup\.com\/t\/[a-z0-9]+/i.test(v) || /\b8[0-9a-z]{7,}\b/i.test(v)
        ? null
        : 'needs a ClickUp task URL or id',
  },
  {
    key: 'repro',
    label: 'Reproduced on the current baseline',
    waivable: true,
    hint: 'What you observed BEFORE the change, on the version that is actually deployed — not the ticket text.',
    check: () => null,
  },
  {
    key: 'test',
    label: 'Automated coverage',
    waivable: true,
    hint: 'Name the test and the command, plus its result. `npm run test:unit -- executions` → 14 passed.',
    check: () => null,
  },
  {
    key: 'staging',
    label: 'Exercised on staging',
    waivable: true,
    hint:
      'Deployed version (v.staging-main.<N> or the commit SHA) + URL + what you clicked + what happened. ' +
      'The version is required because staging routinely runs a different commit than the branch you just pushed.',
    check: (v) => {
      const hasVersion =
        /\bv\.(staging|release)-[A-Za-z0-9._-]+\.\d+\b/.test(v) || /\b[0-9a-f]{7,40}\b/.test(v);
      const hasUrl = /https?:\/\/\S+/.test(v);
      if (!hasVersion && !hasUrl) return 'needs the deployed version (v.staging-main.<N> or SHA) and a URL';
      if (!hasVersion) return 'needs the deployed version that you exercised (v.staging-main.<N> or SHA)';
      if (!hasUrl) return 'needs the URL you exercised';
      return null;
    },
  },
  {
    key: 'rollback',
    label: 'Rollback path',
    waivable: true,
    hint: 'The exact way back: previous image tag, revert commit, or feature flag to flip.',
    check: () => null,
  },
];

const MIN_VALUE_LENGTH = 12;
const MIN_WAIVER_REASON = 20;
const EMPTY_ANSWERS = new Set(['ok', 'okay', 'done', 'yes', 'sim', 'feito', 'n/a', 'na', 'tbd', '-', '—']);

/** Remove fenced code regions, so a worked example inside the block never counts as evidence. */
export function stripFences(text) {
  return text.replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gm, '');
}

/** Every region that follows a start marker, in document order. */
export function extractBlocks(body) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = body.indexOf(MARKER, from);
    if (start === -1) break;
    const after = body.slice(start + MARKER.length);
    const end = after.indexOf(END_MARKER);
    blocks.push(end === -1 ? after : after.slice(0, end));
    from = start + MARKER.length;
  }
  return blocks;
}

/**
 * Extract the evidence block from a PR body. Returns null when no marker is present.
 *
 * A body can mention the marker in prose ("the block between `<!-- evidence-gate:v1 -->`
 * and ...") before carrying the real one — this PR's own description did, and the naive
 * first-match extraction picked up the seven characters between the two inline mentions.
 * So: take the first region that actually contains evidence lines, and fall back to the
 * last region so the per-step errors point at the block the author most likely meant.
 */
export function extractBlock(body) {
  const blocks = extractBlocks(body ?? '');
  if (blocks.length === 0) return null;
  for (const block of blocks) {
    const cleaned = stripFences(block);
    if (parseLines(cleaned).found.size > 0) return cleaned;
  }
  return stripFences(blocks[blocks.length - 1]);
}

/** Parse `- [x] task: value` lines. Backticks around the key are tolerated. */
export function parseLines(block) {
  const found = new Map();
  const duplicates = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/`/g, '');
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(task|repro|test|staging|rollback)\s*:\s*(.*)$/);
    if (!m) continue;
    const entry = { checked: m[1].toLowerCase() === 'x', value: m[3].trim(), raw: raw.trim() };
    if (found.has(m[2])) duplicates.push(m[2]);
    else found.set(m[2], entry);
  }
  return { found, duplicates };
}

function waiverReason(value) {
  const m = value.match(/^n\/?a\b[\s:—–-]*(.*)$/i);
  return m ? m[1].trim() : null;
}

/** @returns {{violations: string[], notes: string[]}} */
export function validate(body) {
  const violations = [];
  const notes = [];

  const block = extractBlock(body ?? '');
  if (block === null) {
    violations.push(
      `The PR body has no evidence block. Copy the block from .github/PULL_REQUEST_TEMPLATE.md ` +
        `(it starts with ${MARKER}) and fill it in.`,
    );
    return { violations, notes };
  }

  const { found, duplicates } = parseLines(block);
  for (const dup of new Set(duplicates)) {
    violations.push(`\`${dup}:\` appears more than once in the evidence block — keep exactly one line per step.`);
  }

  for (const step of STEPS) {
    const entry = found.get(step.key);
    if (!entry) {
      violations.push(`\`${step.key}:\` line is missing — ${step.label}. ${step.hint}`);
      continue;
    }
    if (!entry.checked) {
      violations.push(
        `\`${step.key}:\` is not checked — ${step.label}. An unchecked box means nobody did it; ` +
          `tick it only once the evidence next to it is true.`,
      );
      continue;
    }

    const value = entry.value;
    if (!value || EMPTY_ANSWERS.has(value.toLowerCase())) {
      violations.push(`\`${step.key}:\` is checked but carries no evidence. ${step.hint}`);
      continue;
    }
    if (/<[^>\n]{3,}>/.test(value)) {
      violations.push(`\`${step.key}:\` still contains the template placeholder. Replace \`<...>\` with real evidence.`);
      continue;
    }

    const reason = waiverReason(value);
    if (reason !== null) {
      if (!step.waivable) {
        violations.push(`\`${step.key}:\` cannot be waived. ${step.hint}`);
        continue;
      }
      if (reason.length < MIN_WAIVER_REASON) {
        violations.push(
          `\`${step.key}:\` waived without a real reason. Write \`n/a — <why this step does not apply>\` ` +
            `(at least ${MIN_WAIVER_REASON} characters).`,
        );
        continue;
      }
      notes.push(`\`${step.key}:\` waived — ${reason}`);
      continue;
    }

    if (value.length < MIN_VALUE_LENGTH) {
      violations.push(
        `\`${step.key}:\` evidence is too short to be checkable by someone else. ${step.hint}`,
      );
      continue;
    }

    const problem = step.check(value);
    if (problem) violations.push(`\`${step.key}:\` ${problem}. ${step.hint}`);
  }

  return { violations, notes };
}

// ---------------------------------------------------------------- self test

const FIXTURES = [
  {
    name: 'missing block fails',
    body: '## Summary\nSome change.\n\n## Test plan\n- [ ] check it on staging',
    expect: (r) => r.violations.length === 1 && /no evidence block/.test(r.violations[0]),
  },
  {
    name: 'unchecked line fails (the #414/#417/#425 shape)',
    body: `${MARKER}
- [x] task: https://app.clickup.com/t/86ak66mkx
- [x] repro: tour popover "1 of 3" fired on a fresh project dashboard on v.staging-main.299
- [x] test: npm run test:unit -- onboarding → 6 passed, new case asserts the tour never mounts
- [ ] staging: v.staging-main.301 https://studio-staging.machina.gg fresh session, tour never fired
- [x] rollback: revert the merge commit; no data or schema touched`,
    expect: (r) => r.violations.length === 1 && /`staging:` is not checked/.test(r.violations[0]),
  },
  {
    name: 'staging without a deployed version fails',
    body: `${MARKER}
- [x] task: https://app.clickup.com/t/86ae393wg
- [x] repro: modal blew the page to 19970px with a 3000-char unbroken string
- [x] test: npm run test:unit -- executions → 14 passed
- [x] staging: verified on https://studio-staging.machina.gg, looks right
- [x] rollback: revert the merge commit`,
    expect: (r) => r.violations.length === 1 && /deployed version/.test(r.violations[0]),
  },
  {
    name: 'placeholder left in place fails',
    body: `${MARKER}
- [x] task: https://app.clickup.com/t/86ae393wg
- [x] repro: <what you saw before the change>
- [x] test: npm run test:unit -- executions → 14 passed
- [x] staging: v.staging-main.301 https://studio-staging.machina.gg opened an execution, no overflow
- [x] rollback: revert the merge commit`,
    expect: (r) => r.violations.length === 1 && /placeholder/.test(r.violations[0]),
  },
  {
    name: 'task cannot be waived',
    body: `${MARKER}
- [x] task: n/a — this is only a chore, there is no card for it
- [x] repro: page overflowed horizontally on v.staging-main.299
- [x] test: n/a — pure CSS change, covered by the staging pass below
- [x] staging: v.staging-main.301 https://studio-staging.machina.gg opened an execution, no overflow
- [x] rollback: revert the merge commit`,
    expect: (r) => r.violations.length === 1 && /cannot be waived/.test(r.violations[0]),
  },
  {
    name: 'short waiver reason fails',
    body: `${MARKER}
- [x] task: https://app.clickup.com/t/86ae393wg
- [x] repro: page overflowed horizontally on v.staging-main.299
- [x] test: n/a — css only
- [x] staging: v.staging-main.301 https://studio-staging.machina.gg opened an execution, no overflow
- [x] rollback: revert the merge commit`,
    expect: (r) => r.violations.length === 1 && /without a real reason/.test(r.violations[0]),
  },
  {
    name: 'fully evidenced PR passes',
    body: `## Summary\nFix the modal.\n\n${MARKER}
- [x] \`task:\` https://app.clickup.com/t/86ae393wg
- [x] \`repro:\` on v.staging-main.299 an execution with a 3000-char unbroken value pushed body.scrollWidth to 19995px
- [x] \`test:\` npm run test:unit -- executions → 14 passed, new case asserts scrollWidth === clientWidth
- [x] \`staging:\` v.staging-main.301 · https://studio-staging.machina.gg · opened execution 8f2a in Timeline and Inputs/Outputs, no horizontal scroll at 1280px and 390px
- [x] \`rollback:\` redeploy v.staging-main.299 via Release Staging, or revert the merge commit
${END_MARKER}`,
    expect: (r) => r.violations.length === 0,
  },
  {
    name: 'marker quoted in prose before the real block does not shadow it',
    body: `## How
Parses the block between \`${MARKER}\` and \`${END_MARKER}\`, then validates five keys.

${MARKER}
- [x] task: https://app.clickup.com/t/86akhk9bh
- [x] repro: ran the validator against the live bodies of #414, #417 and #425 — all three exit 1
- [x] test: node .github/scripts/evidence-gate.mjs --selftest → 10/10 passed
- [x] staging: n/a — CI-only change, nothing is bundled, deployed or rendered by it
- [x] rollback: delete the workflow file, or set EVIDENCE_GATE=off
${END_MARKER}`,
    expect: (r) => r.violations.length === 0,
  },
  {
    name: 'the template example inside a code fence is not accepted as evidence',
    body: `${MARKER}
- [ ] task: <ClickUp URL>
- [ ] repro: <what you saw before>
- [ ] test: <test + command>
- [ ] staging: <version + URL>
- [ ] rollback: <way back>

\`\`\`
- [x] task: https://app.clickup.com/t/86ae393wg
- [x] repro: on v.staging-main.299 the modal blew the page to 19970px wide
- [x] test: npm run test:unit -- executions → 14 passed
- [x] staging: v.staging-main.301 https://studio-staging.machina.gg opened an execution, no overflow
- [x] rollback: redeploy v.staging-main.299 via Release Staging
\`\`\`
${END_MARKER}`,
    expect: (r) => r.violations.length === 5 && r.violations.every((v) => /is not checked/.test(v)),
  },
  {
    name: 'valid waiver passes and is reported as a note',
    body: `${MARKER}
- [x] task: https://app.clickup.com/t/86ak66mkx
- [x] repro: tour fired on a fresh dashboard on v.staging-main.299
- [x] test: npm run test:unit -- onboarding → 6 passed
- [x] staging: n/a — docs-only change, nothing is deployed by this PR and no route renders it
- [x] rollback: revert the merge commit`,
    expect: (r) => r.violations.length === 0 && r.notes.length === 1,
  },
];

function selftest() {
  let failed = 0;
  for (const f of FIXTURES) {
    const result = validate(f.body);
    const ok = f.expect(result);
    if (!ok) {
      failed++;
      console.error(`FAIL  ${f.name}`);
      console.error(`      violations: ${JSON.stringify(result.violations, null, 2)}`);
    } else {
      console.log(`ok    ${f.name}`);
    }
  }
  console.log(`\n${FIXTURES.length - failed}/${FIXTURES.length} passed`);
  return failed === 0 ? 0 : 1;
}

// ------------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());

  let body = process.env.PR_BODY ?? '';
  const fileIdx = argv.indexOf('--file');
  if (fileIdx !== -1) {
    const path = argv[fileIdx + 1];
    if (!path) {
      console.error('--file needs a path');
      process.exit(2);
    }
    body = require('node:fs').readFileSync(path, 'utf8');
  }

  const mode = (process.env.EVIDENCE_GATE || 'warn').toLowerCase();
  if (mode === 'off') {
    console.log('Evidence gate is off (EVIDENCE_GATE=off).');
    process.exit(0);
  }

  const { violations, notes } = validate(body);

  if (argv.includes('--json')) {
    process.stdout.write(
      JSON.stringify({ pass: violations.length === 0, violations, notes }, null, 2) + '\n',
    );
    process.exit(violations.length > 0 && mode === 'enforce' ? 1 : 0);
  }

  const summaryLines = [];

  if (violations.length === 0) {
    console.log('Evidence gate passed.');
    summaryLines.push('## Evidence gate — passed', '', 'Every step carries evidence.');
    for (const n of notes) summaryLines.push(`- ${n}`);
  } else {
    summaryLines.push(
      `## Evidence gate — ${violations.length} item(s) missing`,
      '',
      'A green build proves the code compiles. This gate asks for the part a build cannot show:',
      'that someone exercised the change and left behind something another person can re-check.',
      '',
    );
    for (const v of violations) {
      console.error(`::error::${v.replace(/\n/g, ' ')}`);
      summaryLines.push(`- ${v}`);
    }
    summaryLines.push('', 'Edit the PR body and this check re-runs on its own.');
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    require('node:fs').appendFileSync(summaryFile, summaryLines.join('\n') + '\n');
  }

  if (violations.length > 0 && mode === 'enforce') process.exit(1);
  if (violations.length > 0) {
    console.error(
      `\nEvidence gate is in warn mode (EVIDENCE_GATE=${mode}); not failing the build. ` +
        `Set the repository variable EVIDENCE_GATE=enforce to make this blocking.`,
    );
  }
  process.exit(0);
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (import.meta.url === `file://${process.argv[1]}`) main();
