// Shared commitlint config — Machina semantic commits.
// Mirrors the rules enforced by reusable-semantic-pr.yml on PR titles.
// See docs/technical/machina-semantic-commits.md in the docs repo.

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'build', 'ci', 'perf', 'revert'],
    ],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'subject-empty': [2, 'never'],
    'header-max-length': [2, 'always', 100],
  },
};
