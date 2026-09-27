/**
 * scripts/cf-port/migrate/lib/outside-repo.mjs — the ONE check every tool
 * here uses before it writes a plan or a state file: does the path resolve
 * inside the repo? Plans and state files can hold addresses and must never
 * land in the tree.
 *
 * Both the path as given and its real path are tested: a symbolic link
 * outside the repo that points into it is inside. For a path that does not
 * exist yet, the nearest existing ancestor is resolved and the rest appended.
 */

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function isInsideRepo(resolvedPath, repoRoot) {
  const realRepoRoot = existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot;
  let ancestor = resolvedPath;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
  const suffix = path.relative(ancestor, resolvedPath);
  const realResolved = suffix === '' ? realAncestor : path.join(realAncestor, suffix);
  for (const root of [repoRoot, realRepoRoot]) {
    for (const candidate of [resolvedPath, realResolved]) {
      const rel = path.relative(root, candidate);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
    }
  }
  return false;
}
