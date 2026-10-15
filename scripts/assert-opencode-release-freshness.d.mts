export type GitHubRelease = {
  tag_name?: string;
  published_at?: string;
  draft?: boolean;
  target_commitish?: string;
  assets?: Array<{ name: string; digest?: string | null }>;
};

export function latestOpenCodePreview(releases: GitHubRelease[] | GitHubRelease[][]): GitHubRelease;
export function assertOpenCodeReleaseFreshness(
  releases: GitHubRelease[] | GitHubRelease[][],
  pin: { releaseTag: string; sourceSha: string; archiveSha256: string },
): { tag: string; sourceSha: string; archiveSha256: string };
