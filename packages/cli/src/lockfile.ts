import { ok } from 'assert';
import { join } from 'path';
import { parse as parseToml } from 'toml';
import { has, convertToToml } from './utils';
import { pathExists, readFile, writeFile } from './utils/fs';
import { Snapshot, Manifest } from './manifest';
import { Dependency, satisfies } from './manifest/dependency';
import { Workspace } from './workspace';
import {
  Registration,
  getRegistrationId,
  toDependency
} from './sources/registration';
import { DependencyGraph, getRegistration } from './resolve';

export interface Lockfile {
  workspace: {
    root: Snapshot;
    members: Snapshot[];
  };
  packages: DependencyGraph;
}

type DependencyByName = Map<string, Dependency>;

/**
 * Read lockfile at given dir (if present)
 * (for invalid lockfile, errors are ignored and treated as no lockfile)
 * 
 * @param {string} dir
 * @returns {Promise<Lockfile | null>} 
 */
export async function readLockfile(dir: string): Promise<Lockfile | null> {
  try {
    const file = join(dir, 'vba-block.lock');
    if (!await pathExists(file)) return null;

    const toml = await readFile(file, 'utf8');
    return fromToml(toml);
  } catch (err) {
    // TODO Log error

    return null;
  }
}

/**
 * Write lockfile for project to given dir
 * 
 * @param {string} dir 
 * @param {Lockfile} lockfile 
 */
export async function writeLockfile(
  dir: string,
  lockfile: Lockfile
): Promise<void> {
  const file = join(dir, 'vba-block.lock');
  const toml = toToml(lockfile);

  return writeFile(file, toml);
}

/**
 * Check if lockfile is still valid for loaded workspace
 * (e.g. invalidated by changing/adding dependency to manifest)
 * 
 * @param {Lockfile} lockfile 
 * @param {Workspace} workspace
 * @returns {boolean} 
 */
export function isLockfileValid(
  lockfile: Lockfile,
  workspace: Workspace
): boolean {
  if (!compareDependencies(workspace.root, lockfile.workspace.root))
    return false;

  if (lockfile.workspace.members.length !== workspace.members.length)
    return false;

  const byName: { [name: string]: Snapshot } = {};
  workspace.members.forEach(member => (byName[member.name] = member));

  for (const member of lockfile.workspace.members) {
    const currentMember = byName[member.name];
    if (!currentMember) return false;
    if (!compareDependencies(currentMember, member)) return false;
  }

  return true;
}

/**
 * Convert lockfile/project to toml
 * - toml, alphabetized and with trailing commas, should be suitable for VCS
 * 
 * @param {Lockfile} lockfile
 * @returns {string} 
 */
export function toToml(lockfile: Lockfile): string {
  const root = prepareManifest(lockfile.workspace.root, lockfile.packages);
  const members: any[] = lockfile.workspace.members.map((member: Manifest) =>
    prepareManifest(member, lockfile.packages)
  );
  const packages: any[] = lockfile.packages.map(
    (registration: Registration) => {
      const { name, version, source } = registration;
      const dependencies = registration.dependencies.map(dependency =>
        toDependencyId(dependency, lockfile.packages)
      );

      return {
        name,
        version,
        source,
        dependencies
      };
    }
  );

  return convertToToml({ root, members, packages });
}

/**
 * Load lockfile from toml (including "hydrating" dependencies from packages)
 * 
 * @param {string} toml
 * @returns {Lockfile} 
 */
export function fromToml(toml: string): Lockfile {
  const parsed = parseToml(toml);
  ok(has(parsed, 'root'), 'vba-block.lock is missing [root] field');

  // First pass through packages to load high-level information
  // (needed to map dependencies to parsed packages)
  const byName: DependencyByName = new Map();
  const packages = (parsed.packages || []).map((value: any) => {
    const { name, version, source, dependencies } = value;
    ok(
      name && version && source && Array.isArray(dependencies),
      'Invalid package in lockfile'
    );

    const registration = {
      id: getRegistrationId(name, version),
      name,
      version,
      source,
      dependencies
    };

    byName.set(name, toDependency(registration));

    return registration;
  });

  // Hydrate dependencies of packages
  packages.forEach((registration: any) => {
    registration.dependencies = registration.dependencies.map((id: string) =>
      getDependency(id, byName)
    );
  });

  // Load manifests for workspace
  const root = toManifest(parsed.root, byName);
  const members = (parsed.members || []).map((member: any) =>
    toManifest(member, byName)
  );

  return { workspace: { root, members }, packages };
}

// Convert raw toml value to manifest
function toManifest(value: any, byName: DependencyByName): Snapshot {
  const { name, version } = value;
  ok(
    name && version && Array.isArray(value.dependencies),
    'Invalid manifest in lockfile'
  );

  const dependencies = value.dependencies.map((id: string) =>
    getDependency(id, byName)
  );

  return {
    name,
    version,
    dependencies
  };
}

// Prepare manifest for toml
function prepareManifest(manifest: Snapshot, packages: DependencyGraph): any {
  const { name, version } = manifest;
  const dependencies = manifest.dependencies.map(dependency =>
    toDependencyId(dependency, packages)
  );

  return {
    name,
    version,
    dependencies
  };
}

// Get dependency id
//
// Minimum information needed for lockfile:
// "{name} {version} {source}"
function toDependencyId(dependency: Dependency, packages: DependencyGraph) {
  const registration = getRegistration(packages, dependency);
  ok(registration, 'No package found for dependency');

  const { version, source } = registration!;
  return `${dependency.name} ${version} ${source}`;
}

// Get dependency by id (using name from id)
function getDependency(id: string, byName: DependencyByName): Dependency {
  const [name] = id.split(' ', 1);
  const dependency = byName.get(name);

  ok(dependency, `Package not found in lockfile, "${id}"`);

  return dependency!;
}

// Compare dependencies between current user manifest and lockfile manifest
function compareDependencies(current: Snapshot, locked: Snapshot): boolean {
  if (current.dependencies.length !== locked.dependencies.length) return false;

  const byName: { [name: string]: Dependency } = {};
  current.dependencies.forEach(
    dependency => (byName[dependency.name] = dependency)
  );

  for (const dependency of locked.dependencies) {
    const currentValue = byName[dependency.name];
    if (!currentValue) return false;
    if (!satisfies(currentValue, dependency)) return false;
  }

  return true;
}
