/**
 * GitHub webhook events as channel message text.
 *
 * Payload shapes: https://docs.github.com/en/webhooks/webhook-events-and-payloads. Each
 * message opens with the repository in bold and ends with a link in <...>, which the message
 * builder keeps as a link without a preview. Events and actions not listed in
 * formatGithubEvent post nothing.
 */

const MAX_COMMITS = 5;
const COMMIT_LINE = 72;
const TITLE = 120;
const EXCERPT = 280;

type Json = Record<string, any>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** First line, whitespace collapsed, at most n characters. */
export function clip(value: unknown, n: number): string {
  const line = str(value).split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line;
}

/** A body as a one-paragraph quote, or '' when empty. */
function excerpt(value: unknown): string {
  const text = str(value)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return `> ${text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1).trimEnd()}…` : text}`;
}

function link(url: unknown): string {
  const u = str(url);
  return /^https:\/\/[^\s<>]+$/.test(u) ? `<${u}>` : '';
}

function lines(...parts: string[]): string {
  return parts.filter(Boolean).join('\n');
}

function repoName(p: Json): string {
  return clip(p.repository?.full_name || p.organization?.login || p.sender?.login || 'GitHub', 100);
}

function actor(p: Json): string {
  return clip(p.sender?.login || p.pusher?.name || 'someone', 40);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function push(p: Json): string | null {
  const repo = repoName(p);
  const ref = str(p.ref);
  const isTag = ref.startsWith('refs/tags/');
  const name = clip(ref.replace(/^refs\/(heads|tags)\//, ''), 100);
  if (!name) return null;
  const kind = isTag ? 'tag' : 'branch';
  const tree = p.repository?.html_url ? `${p.repository.html_url}/tree/${encodeURIComponent(name)}` : '';

  if (p.deleted) return `**${repo}**: ${actor(p)} deleted ${kind} \`${name}\``;

  const commits: Json[] = Array.isArray(p.commits) ? p.commits : [];
  if (isTag || commits.length === 0) {
    if (!p.created) return null;
    return lines(`**${repo}**: ${actor(p)} created ${kind} \`${name}\``, link(tree));
  }

  const shown = commits.slice(0, MAX_COMMITS).map((c) => {
    const author = clip(c.author?.username || c.author?.name, 40);
    return `\`${str(c.id).slice(0, 7)}\` ${clip(c.message, COMMIT_LINE)}${author ? ` - ${author}` : ''}`;
  });
  const more = commits.length > MAX_COMMITS ? `and ${commits.length - MAX_COMMITS} more` : '';
  return lines(
    `**${repo}**: ${actor(p)} ${p.forced ? 'force-pushed' : 'pushed'} ${plural(commits.length, 'commit')} to \`${name}\``,
    ...shown,
    more,
    link(p.compare),
  );
}

const PR_VERBS: Record<string, string> = {
  opened: 'opened',
  reopened: 'reopened',
  ready_for_review: 'marked ready for review',
};

function pullRequest(p: Json): string | null {
  const pr = p.pull_request;
  if (!pr) return null;
  const verb = p.action === 'closed' ? (pr.merged ? 'merged' : 'closed') : PR_VERBS[str(p.action)];
  if (!verb) return null;
  return lines(
    `**${repoName(p)}**: ${actor(p)} ${verb} pull request #${Number(pr.number ?? p.number) || ''}: ${clip(pr.title, TITLE)}`,
    p.action === 'opened' ? excerpt(pr.body) : '',
    link(pr.html_url),
  );
}

const ISSUE_VERBS: Record<string, string> = { opened: 'opened', closed: 'closed', reopened: 'reopened' };

function issues(p: Json): string | null {
  const issue = p.issue;
  const verb = ISSUE_VERBS[str(p.action)];
  if (!issue || !verb) return null;
  return lines(
    `**${repoName(p)}**: ${actor(p)} ${verb} issue #${Number(issue.number) || ''}: ${clip(issue.title, TITLE)}`,
    p.action === 'opened' ? excerpt(issue.body) : '',
    link(issue.html_url),
  );
}

function issueComment(p: Json): string | null {
  const issue = p.issue;
  if (p.action !== 'created' || !issue || !p.comment) return null;
  const kind = issue.pull_request ? 'pull request' : 'issue';
  return lines(
    `**${repoName(p)}**: ${actor(p)} commented on ${kind} #${Number(issue.number) || ''}: ${clip(issue.title, TITLE)}`,
    excerpt(p.comment.body),
    link(p.comment.html_url),
  );
}

function release(p: Json): string | null {
  const r = p.release;
  if (p.action !== 'published' || !r) return null;
  const name = clip(r.name || r.tag_name, TITLE);
  return lines(
    `**${repoName(p)}**: ${actor(p)} published ${r.prerelease ? 'pre-release' : 'release'} **${name}**`,
    link(r.html_url),
  );
}

const CONCLUSIONS: Record<string, string> = {
  success: 'succeeded',
  failure: 'failed',
  cancelled: 'was cancelled',
  timed_out: 'timed out',
  action_required: 'needs action',
  startup_failure: 'failed to start',
};

function workflowRun(p: Json): string | null {
  const run = p.workflow_run;
  const outcome = CONCLUSIONS[str(run?.conclusion)];
  if (p.action !== 'completed' || !outcome) return null;
  const branch = clip(run.head_branch, 100);
  return lines(
    `**${repoName(p)}**: workflow **${clip(run.name || p.workflow?.name, TITLE)}** ${outcome}${branch ? ` on \`${branch}\`` : ''}`,
    link(run.html_url),
  );
}

function checkRun(p: Json): string | null {
  const run = p.check_run;
  const outcome = CONCLUSIONS[str(run?.conclusion)];
  if (p.action !== 'completed' || !outcome) return null;
  const branch = clip(run.check_suite?.head_branch, 100);
  return lines(
    `**${repoName(p)}**: check **${clip(run.name, TITLE)}** ${outcome}${branch ? ` on \`${branch}\`` : ''}`,
    link(run.html_url || run.details_url),
  );
}

function star(p: Json): string | null {
  if (p.action !== 'created') return null;
  const count = Number(p.repository?.stargazers_count);
  return `**${repoName(p)}**: ${actor(p)} starred the repository${Number.isFinite(count) && count > 0 ? ` (${plural(count, 'star')})` : ''}`;
}

function ping(p: Json): string {
  const events: string[] = Array.isArray(p.hook?.events) ? p.hook.events.filter((e: unknown) => typeof e === 'string') : [];
  const list = events.length > 0 ? ` Events: ${clip(events.join(', '), 200)}.` : '';
  return `**${repoName(p)}**: GitHub webhook connected.${list}`;
}

const FORMATTERS: Record<string, (p: Json) => string | null> = {
  ping,
  push,
  pull_request: pullRequest,
  issues,
  issue_comment: issueComment,
  release,
  workflow_run: workflowRun,
  check_run: checkRun,
  star,
};

/** Message text for an X-GitHub-Event delivery, or null when the event posts nothing. */
export function formatGithubEvent(event: string | undefined, payload: unknown): string | null {
  if (!event || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const format = FORMATTERS[event];
  return format ? format(payload as Json) : null;
}
