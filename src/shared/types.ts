export interface ReleaseInfo {
  codename: string;
  suite: string;
  date: string;
  architectures: string[];
  components: string[];
  /** Changelogs: template from the Release file, with "@CHANGEPATH@" placeholder. */
  changelogsTemplate: string;
}

export interface PackageEntry {
  name: string;
  version: string;
  arch: string;
  section: string;
  /** Path of the .deb in the repo (e.g. dists/…/binary-amd64/foo_1.1_amd64.deb). */
  filename: string;
  source?: string;
  /** First (short) line of the Description field. */
  description: string;
  /** Publish time (epoch ms) of the current version, from the binary dir listing; null if unknown. */
  released: number | null;
}

export interface PackageList {
  suite: string;
  component: string;
  arch: string;
  total: number;
  packages: PackageEntry[];
}

export interface ChangelogEntry {
  version: string;
  codename: string;
  urgency: string;
  maintainer?: string;
  date?: string;
  /** Non-empty trimmed change lines. */
  changes: string[];
}

export interface Changelog {
  suite: string;
  component: string;
  package: string;
  /** The version whose changelog file was read. */
  version: string;
  entries: ChangelogEntry[];
}