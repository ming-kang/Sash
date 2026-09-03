const CORE_VERSION_TOKEN_CHARACTER = /^[A-Za-z0-9._-]$/;

function isCoreVersionTokenCharacter(value: string | undefined): boolean {
  return value !== undefined && CORE_VERSION_TOKEN_CHARACTER.test(value);
}

/** Match a literal release token without accepting a larger version-like token. */
export function containsCoreVersionToken(observed: string, expected: string): boolean {
  if (expected.length === 0) return false;

  let index = observed.indexOf(expected);
  while (index >= 0) {
    const end = index + expected.length;
    if (
      !isCoreVersionTokenCharacter(index === 0 ? undefined : observed[index - 1]) &&
      !isCoreVersionTokenCharacter(end === observed.length ? undefined : observed[end])
    ) {
      return true;
    }
    index = observed.indexOf(expected, index + 1);
  }
  return false;
}
