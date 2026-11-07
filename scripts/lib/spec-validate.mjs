export const SPEC_TARGET_LINES = 300;
export const SPEC_HARD_LINES = 400;

const REQUIRED_ARTIFACTS = ['proposal.md', 'design.md', 'tasks.md'];
const CAPABILITY_SPEC_PATTERN = /^specs\/[^/]+\/spec\.md$/;

/**
 * Validates one `openspec/changes/<id>` package against this workspace's local
 * convention (`openspec/config.yaml`): proposal/design/tasks plus at least one
 * capability spec must exist, and no markdown file may exceed the line ceiling.
 */
export function validateSpecPackage({ id, files, limits = {} }) {
  const targetLines = limits.targetLines ?? SPEC_TARGET_LINES;
  const hardLines = limits.hardLines ?? SPEC_HARD_LINES;
  const errors = [];
  const warnings = [];
  const paths = files.map((file) => file.path);

  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!paths.includes(artifact)) {
      errors.push(`${id} is missing ${artifact}.`);
    }
  }

  if (!paths.some((path) => CAPABILITY_SPEC_PATTERN.test(path))) {
    errors.push(`${id} is missing specs/<capability>/spec.md.`);
  }

  for (const { path, lines } of files) {
    if (!path.endsWith('.md')) continue;
    if (lines > hardLines) {
      errors.push(`${id}/${path} is ${lines} lines, over the ${hardLines}-line ceiling.`);
    } else if (lines > targetLines) {
      warnings.push(`${id}/${path} is ${lines} lines, over the ${targetLines}-line target.`);
    }
  }

  return { errors, warnings };
}
