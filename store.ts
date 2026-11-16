// store.ts: the forge's single in-memory store. One tenant (the token's owner,
// learned from the first owner-named request), one global content-addressed object
// store, and per-repo refs, labels, issues and pull requests sharing one number
// sequence. Every id, timestamp and counter is a deterministic function of the
// request sequence: forge-made commits take their timestamps from a per-repo
// counter over a fixed epoch, never from the wall clock.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObj,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

export const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
const FORGE_IDENTITY = 'Forge <forge@make.fun>';

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  nextCommentId: number;
}

export interface PullRec {
  kind: 'pull';
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export type ItemRec = IssueRec | PullRec;

export interface Repo {
  name: string;
  databaseId: number;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  items: Map<number, ItemRec>;
  nextNumber: number;
  commitSeq: number;
  version: number; // bumped on every ref change; keys the pack cache
}

export class Forge {
  readonly objects = new Map<string, GitObj>();
  readonly repos = new Map<string, Repo>();
  ownerLogin: string | null = null;
  private repoSeq = 0;
  private itemSeq = 0;
  readonly itemIds = new Map<string, number>(); // "repoName#number" -> stable REST id

  /** The owner login, learning it from the first owner-named request. */
  learnOwner(login: string): void {
    if (this.ownerLogin === null && login !== '') this.ownerLogin = login;
  }

  /** True when `login` may address this forge's repos (unknown owner learns; foreign is 404). */
  ownerMatches(login: string): boolean {
    this.learnOwner(login);
    return this.ownerLogin === login;
  }

  viewerLogin(): string {
    return this.ownerLogin ?? 'viewer';
  }

  // -------------------------------------------------------------- objects

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  lookup = (oid: string): GitObj | undefined => this.objects.get(oid);

  // -------------------------------------------------------------- repos

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      name,
      databaseId: this.repoSeq,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      commitSeq: 0,
      version: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  repoList(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.databaseId - b.databaseId);
  }

  /** A stable numeric REST id for an issue or pull request, assigned at creation. */
  itemId(repo: Repo, number: number): number {
    const key = `${repo.name}#${number}`;
    let id = this.itemIds.get(key);
    if (id === undefined) {
      this.itemSeq += 1;
      id = this.itemSeq;
      this.itemIds.set(key, id);
    }
    return id;
  }

  // -------------------------------------------------------------- commits and trees

  /** Make a forge commit (contents writes, squash merges) with a deterministic timestamp. */
  forgeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    repo.commitSeq += 1;
    const timestamp = EPOCH_SEC + repo.commitSeq;
    const line = `${FORGE_IDENTITY} ${timestamp} +0000`;
    const data = buildCommit({ tree, parents, authorLine: line, committerLine: line, message });
    return this.putObject('commit', data);
  }

  commitTree(oid: string): string | null {
    const object = this.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return parseCommit(object.data).tree;
    if (object.type === 'tag') {
      const target = peelToCommit(oid, this.lookup);
      return target === null ? null : this.commitTree(target);
    }
    return null;
  }

  /** Flatten a tree (by oid) into path -> blob oid. */
  flattenTree(treeOid: string | null): Map<string, string> {
    const out = new Map<string, string>();
    if (treeOid === null) return out;
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else if (entry.mode !== '160000') out.set(`${prefix}${entry.name}`, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path -> blob oid map. */
  treeFromFlat(flat: ReadonlyMap<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The blob oid at `path` in a tree, or null. */
  blobAt(treeOid: string | null, path: string): string | null {
    if (treeOid === null) return null;
    const segments = path.split('/');
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The tree oid at a directory `path` ('' is the root), or null. */
  treeAt(treeOid: string | null, path: string): string | null {
    if (treeOid === null) return null;
    if (path === '' || path === '/') return treeOid;
    let current = treeOid;
    for (const segment of path.split('/')) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return current;
  }

  /** Directory entries of the tree at `path`: {type, name, path, sha}. */
  listDir(treeOid: string | null, path: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | null {
    const dirOid = this.treeAt(treeOid, path);
    if (dirOid === null) return null;
    const object = this.objects.get(dirOid);
    if (object === undefined || object.type !== 'tree') return null;
    const prefix = path === '' || path === '/' ? '' : `${path.replace(/\/+$/, '')}/`;
    return parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      name: entry.name,
      path: `${prefix}${entry.name}`,
      sha: entry.oid,
    }));
  }

  // -------------------------------------------------------------- refs

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setRef(repo: Repo, ref: string, oid: string | null): void {
    if (oid === null) repo.refs.delete(ref);
    else repo.refs.set(ref, oid);
    repo.version += 1;
  }

  /** Resolve a REST `ref`/`sha` argument: branch name, full ref, tag name, or a commit oid. */
  resolveCommitish(repo: Repo, value: string): string | null {
    const byBranch = repo.refs.get(`refs/heads/${value}`);
    if (byBranch !== undefined) return byBranch;
    const byRef = repo.refs.get(value);
    if (byRef !== undefined) return byRef;
    const byTag = repo.refs.get(`refs/tags/${value}`);
    if (byTag !== undefined) return peelToCommit(byTag, this.lookup) ?? byTag;
    if (/^[0-9a-f]{40}$/.test(value) && this.objects.has(value)) {
      return peelToCommit(value, this.lookup) ?? value;
    }
    return null;
  }

  /** Ancestors of a commit in walk order (tip first), following every parent. */
  ancestors(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** DFS from `tip` looking for `maybeAncestor`, exiting the moment it is found. */
  isAncestor(maybeAncestor: string, tip: string): boolean {
    if (maybeAncestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === maybeAncestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The merge base of two commits: the first commit of b's walk that is an ancestor of a. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set(this.ancestors(a));
    for (const candidate of this.ancestors(b)) {
      if (ancestorsOfA.has(candidate)) return candidate;
    }
    return null;
  }

  // -------------------------------------------------------------- reachability / fetch sets

  /** Full object closure of the given tips (commits, trees, blobs, tags). */
  closure(tips: Iterable<string>, shallowBoundary?: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const tip of tips) if (this.objects.has(tip)) queue.push(tip);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (shallowBoundary === undefined || !shallowBoundary.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /**
   * The object set a fetch must send. With a depth, commits are included by BFS
   * generation from the wants (wants are generation 1) up to the depth, with their
   * full trees and blobs; the shallow boundary is the included commits whose parents
   * were cut off, and `unshallow` lists the client's old boundary commits that gained
   * parents in this fetch.
   */
  fetchSet(
    wants: readonly string[],
    haves: readonly string[],
    clientShallow: readonly string[],
    depth: number | null,
  ): { send: string[]; shallow: string[]; unshallow: string[] } {
    const shallowSet = new Set(clientShallow);
    const haveClosure = this.closure(haves, shallowSet);
    let include: Set<string>;
    const boundary = new Set<string>();
    if (depth === null) {
      include = this.closure(wants);
      // A full fetch unshallows every old boundary commit it completes.
      const unshallow = clientShallow.filter((oid) => include.has(oid));
      const send = [...include].filter((oid) => !haveClosure.has(oid));
      return { send, shallow: [], unshallow };
    }
    // BFS generations over commits.
    const generation = new Map<string, number>();
    const queue: string[] = [];
    for (const want of wants) {
      const commit = peelToCommit(want, this.lookup) ?? want;
      if (!generation.has(commit)) {
        generation.set(commit, 1);
        queue.push(commit);
      }
    }
    while (queue.length > 0) {
      const oid = queue.shift()!;
      const gen = generation.get(oid)!;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (gen >= depth) {
        if (parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of parents) {
        if (!generation.has(parent)) {
          generation.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
    const includedCommits = [...generation.keys()];
    include = new Set<string>();
    for (const commit of includedCommits) {
      const object = this.objects.get(commit);
      if (object === undefined) continue;
      include.add(commit);
      const tree = parseCommit(object.data).tree;
      for (const oid of this.closure([tree])) include.add(oid);
    }
    for (const want of wants) {
      if (this.objects.get(want)?.type === 'tag') {
        for (const oid of this.closure([want], boundary)) include.add(oid);
      }
    }
    const send = [...include].filter((oid) => !haveClosure.has(oid));
    const shallow = [...boundary].filter((oid) => this.objects.has(oid));
    const unshallow = clientShallow.filter((oid) => include.has(oid) && !boundary.has(oid));
    return { send, shallow, unshallow };
  }

  // -------------------------------------------------------------- pull merge

  /** Paths whose blob differs between two flat trees (either side may lack the path). */
  static changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    const changed: string[] = [];
    for (const path of paths) {
      if (before.get(path) !== after.get(path)) changed.push(path);
    }
    return changed.sort();
  }

  /** True when merging head into base's current tip would conflict (same path changed both sides, differently). */
  pullConflict(repo: Repo, pull: PullRec): boolean {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (baseTip === null || headTip === null) return true;
    const base = this.mergeBase(baseTip, headTip);
    if (base === null) return true;
    const baseTree = this.flattenTree(this.commitTree(base));
    const headTree = this.flattenTree(this.commitTree(headTip));
    const currentTree = this.flattenTree(this.commitTree(baseTip));
    const headChanged = new Set(Forge.changedPaths(baseTree, headTree));
    for (const path of Forge.changedPaths(baseTree, currentTree)) {
      if (headChanged.has(path) && headTree.get(path) !== currentTree.get(path)) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the squash commit oid,
   * or null when the merge conflicts (or a ref is missing).
   */
  mergePull(repo: Repo, pull: PullRec): string | null {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (baseTip === null || headTip === null) return null;
    if (this.pullConflict(repo, pull)) return null;
    const base = this.mergeBase(baseTip, headTip);
    if (base === null) return null;
    if (base === headTip) return null; // nothing to merge
    const baseTree = this.flattenTree(this.commitTree(base));
    const headTree = this.flattenTree(this.commitTree(headTip));
    const merged = this.flattenTree(this.commitTree(baseTip));
    for (const path of Forge.changedPaths(baseTree, headTree)) {
      const oid = headTree.get(path);
      if (oid === undefined) merged.delete(path);
      else merged.set(path, oid);
    }
    const tree = this.treeFromFlat(merged);
    const message = `${pull.title} (#${pull.number})\n`;
    const sha = this.forgeCommit(repo, tree, [baseTip], message);
    this.setRef(repo, `refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = new Date((EPOCH_SEC + repo.commitSeq) * 1000).toISOString();
    return sha;
  }

  /** The file diff of a pull request: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: PullRec): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (baseTip === null || headTip === null) return [];
    const base = this.mergeBase(baseTip, headTip) ?? baseTip;
    const before = this.flattenTree(this.commitTree(base));
    const after = this.flattenTree(this.commitTree(headTip));
    const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const path of Forge.changedPaths(before, after)) {
      const oldOid = before.get(path);
      const newOid = after.get(path);
      const oldLines = oldOid === undefined ? [] : linesOf(this.objects.get(oldOid)?.data);
      const newLines = newOid === undefined ? [] : linesOf(this.objects.get(newOid)?.data);
      const { additions, deletions } = lineDiff(oldLines, newLines);
      files.push({
        filename: path,
        status: oldOid === undefined ? 'added' : newOid === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }
}

/** A blob's lines: newline-terminated lines plus a final partial line. */
export function linesOf(data: Buffer | undefined): string[] {
  if (data === undefined || data.length === 0) return [];
  const lines = data.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line diff: additions are lines only in `after`, deletions only in `before`. */
export function lineDiff(before: readonly string[], after: readonly string[]): { additions: number; deletions: number } {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of after) {
    const count = counts.get(line) ?? 0;
    if (count > 0) counts.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of counts.values()) deletions += count;
  return { additions, deletions };
}
