import { join } from 'path';
import { Project } from '../../src/project';
import { Manifest } from '../../src/manifest';
import { Workspace } from '../../src/workspace';
import { getConfig } from '../helpers/config';
import * as manifest from './manifest';

export const simple = toProject(manifest.simple);
export const complex = toProject(manifest.complex);

export function toProject(manifest: Manifest): Project {
  const config = getConfig();
  const paths = {
    root: manifest.dir,
    dir: manifest.dir,
    build: join(manifest.dir, 'build'),
    backup: join(manifest.dir, 'build', '.backup')
  };

  return {
    manifest,
    workspace: { root: manifest, members: [] },
    packages: [],
    config,
    paths
  };
}