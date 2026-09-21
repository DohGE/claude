#!/usr/bin/env node
'use strict';

// Everything fixPr needs from GitHub that codeReview's github.cjs does
// not already provide: the review THREADS of a pull request, and the two REST
// lists holding the rest of its discussion.
//
// Why GraphQL at all: `GET /pulls/{n}/comments` returns every inline comment
// with no hint that its thread was resolved. Resolution is a property of the
// THREAD, and threads exist only in GraphQL - so a fixer built on REST alone
// would re-fix everything the reviewer already signed off on, which is the one
// thing this skill must never do.
//
// The token, the owner/repo slug, the open pull request and the HTTP primitive
// itself all come from ../../codeReview/scripts/github.cjs. The two skills ship
// in one plugin and always travel together, so requiring it beats a second copy
// of six token sources that would drift out of sync with the first.

const github = require('../../codeReview/scripts/github.cjs');

const graphqlUrl = 'https://api.github.com/graphql';
const threadsPerPage = 50;
const commentsPerPage = 50;
// A pull request with more than 2 000 review threads is not a code review, and
// an unbounded loop against a paginated API is how a script hangs forever on a
// server that keeps answering `hasNextPage: true`.
const maxPages = 40;

const threadsQuery = `query($owner:String!,$repo:String!,$number:Int!,$threads:Int!,$comments:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:$threads,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id isResolved isOutdated viewerCanResolve
          path line startLine originalLine originalStartLine diffSide
          comments(first:$comments){
            pageInfo{hasNextPage endCursor}
            nodes{databaseId url createdAt body diffHunk author{login __typename}}
          }
        }
      }
    }
  }
}`;

const threadCommentsQuery = `query($id:ID!,$comments:Int!,$cursor:String){
  node(id:$id){
    ... on PullRequestReviewThread{
      comments(first:$comments,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{databaseId url createdAt body diffHunk author{login __typename}}
      }
    }
  }
}`;

const resolveMutation = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}
}`;

// GraphQL answers a rejected query with HTTP 200 and an `errors` array, so
// `res.ok` alone says nothing: a query the token may not run comes back as a
// perfectly successful response carrying no data at all.
function graphql(project, query, variables, send = github.request) {
  const res = send(project, { url: graphqlUrl, method: 'POST', body: { query, variables } });
  if (!res || !res.ok) return { data: null, error: (res && res.error) || `HTTP ${(res && res.status) || 0}` };
  if (!res.json) return { data: null, error: 'the GraphQL response could not be read' };
  const errors = Array.isArray(res.json.errors) ? res.json.errors : [];
  if (errors.length) {
    const message = errors.map((e) => (e && e.message) || '').filter(Boolean).join('; ');
    return { data: null, error: message || 'GitHub rejected the GraphQL query' };
  }
  return { data: res.json.data || null, error: null };
}

function normalizeComment(node) {
  return {
    id: node && node.databaseId != null ? node.databaseId : null,
    author: (node && node.author && node.author.login) || null,
    // A GitHub App is a `Bot` actor in GraphQL, which is the same marker REST spells
    // `user.type === 'Bot'`. Review bots post INLINE now - a single run of one can open
    // forty threads next to a reviewer's three - so a brief that cannot say who is
    // speaking makes them weigh the same. The flag travels; the verdict stays the
    // agent's, because a bot anchored to a real line is often naming a real defect.
    isBot: Boolean(node && node.author && node.author.__typename === 'Bot'),
    body: (node && node.body) || '',
    createdAt: (node && node.createdAt) || null,
    url: (node && node.url) || null,
    diffHunk: (node && node.diffHunk) || null,
  };
}

// An outdated thread has no current `line` - the code moved under it - and
// GitHub reports `null` there while keeping `originalLine`. Both travel, so the
// fixer can tell "line 42 of the file as it stands" from "line 42 of a diff
// that no longer applies" instead of trusting a number that means neither.
// `diffHunk` belongs to the thread, not to each of its comments: it is the hunk the
// thread is anchored to, and GitHub repeats it verbatim on every reply. On an ordinary
// review round that repetition is about a sixth of the whole brief the fixing agent
// reads, spent on text it has already seen. It travels once, as the thread own, and a
// comment keeps a copy only where it genuinely differs - so nothing can be lost here.
function stripAnchor(comments, anchor) {
  for (const comment of comments) {
    if (comment.diffHunk === anchor) delete comment.diffHunk;
  }
  return comments;
}

function normalizeThread(node) {
  const comments = ((node.comments && node.comments.nodes) || []).filter(Boolean).map(normalizeComment);
  const diffHunk = comments.length ? comments[0].diffHunk : null;
  return {
    id: node.id,
    isResolved: Boolean(node.isResolved),
    isOutdated: Boolean(node.isOutdated),
    viewerCanResolve: node.viewerCanResolve !== false,
    path: node.path || null,
    line: node.line == null ? null : node.line,
    startLine: node.startLine == null ? null : node.startLine,
    originalLine: node.originalLine == null ? null : node.originalLine,
    originalStartLine: node.originalStartLine == null ? null : node.originalStartLine,
    diffSide: node.diffSide || null,
    diffHunk,
    comments: stripAnchor(comments, diffHunk),
  };
}

// The comments past the first page of one thread. A long argument is exactly
// where the reviewer's final ask tends to sit, so dropping the tail would keep
// the opening complaint and lose its conclusion.
function restOfThread(project, threadId, cursor, send = github.request) {
  const comments = [];
  let next = cursor;
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = graphql(project, threadCommentsQuery, { id: threadId, comments: commentsPerPage, cursor: next }, send);
    if (error) return { comments, error };
    const block = data && data.node && data.node.comments;
    if (!block) return { comments, error: 'the rest of the thread could not be read' };
    comments.push(...(block.nodes || []).filter(Boolean).map(normalizeComment));
    const info = block.pageInfo || {};
    if (!info.hasNextPage) return { comments, error: null };
    next = info.endCursor;
  }
  return { comments, error: 'the thread holds more comments than this script pages through' };
}

// Every review thread of the pull request, resolved ones included: filtering is
// the caller's decision, and a count of what was already resolved is worth
// reporting. `truncated` says the list is incomplete, so a caller never reads a
// partial answer as "that is all of them".
function reviewThreads(project, slug, number, send = github.request) {
  const threads = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = graphql(project, threadsQuery, {
      owner: slug.owner,
      repo: slug.repo,
      number: Number(number),
      threads: threadsPerPage,
      comments: commentsPerPage,
      cursor,
    }, send);
    if (error) return { threads, error, truncated: true };
    const pr = data && data.repository && data.repository.pullRequest;
    if (!pr || !pr.reviewThreads) {
      return { threads, error: `the API returned no review threads for pull request #${number}`, truncated: true };
    }
    for (const node of pr.reviewThreads.nodes || []) {
      if (!node) continue;
      const thread = normalizeThread(node);
      const info = (node.comments && node.comments.pageInfo) || {};
      if (info.hasNextPage) {
        // Only for a thread somebody still has to act on. A resolved thread is
        // finished work whose comments no caller reads - it travels for its
        // count alone - so paging through the tail of one would be a GraphQL
        // round trip per page spent on text that is thrown away. The truncation
        // is recorded rather than hidden: the list IS short, and a caller that
        // later starts reading resolved threads must see that, not discover it.
        if (thread.isResolved) {
          thread.commentsTruncated = 'the thread is resolved, so its comments past the first page were not fetched';
        } else {
          const more = restOfThread(project, node.id, info.endCursor, send);
          thread.comments.push(...stripAnchor(more.comments, thread.diffHunk));
          if (more.error) thread.commentsTruncated = more.error;
        }
      }
      threads.push(thread);
    }
    const info = pr.reviewThreads.pageInfo || {};
    if (!info.hasNextPage) return { threads, error: null, truncated: false };
    cursor = info.endCursor;
  }
  return { threads, error: null, truncated: true };
}

function resolveThread(project, threadId, send = github.request) {
  const { data, error } = graphql(project, resolveMutation, { id: threadId }, send);
  if (error) return { resolved: false, error };
  const thread = data && data.resolveReviewThread && data.resolveReviewThread.thread;
  if (!thread) return { resolved: false, error: 'GitHub accepted the mutation but returned no thread' };
  if (!thread.isResolved) return { resolved: false, error: 'the thread came back still unresolved' };
  return { resolved: true, error: null };
}

// One REST list, paged to exhaustion. `page` is 1-based and a short page is the
// last one, which is the only end condition that does not need the Link header.
const restPerPage = 100;

function restList(project, pathFor, send, map) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = send(project, { path: pathFor(page) });
    if (!res || !res.ok) return { items: out, error: (res && res.error) || 'the request failed', truncated: true };
    const nodes = Array.isArray(res.json) ? res.json : [];
    for (const node of nodes) {
      const mapped = map(node);
      if (mapped) out.push(mapped);
    }
    if (nodes.length < restPerPage) return { items: out, error: null, truncated: false };
  }
  // Running out of pages is the same kind of answer as a failed request: the
  // list is short. Saying so here is what keeps a caller from reading the tail
  // of a very long conversation as "there was nothing more".
  return { items: out, error: null, truncated: true };
}

// The conversation tab: comments that belong to no code line and therefore to
// no thread. GitHub has no resolved state for them at all - which is why the
// skill classifies them instead of filtering them.
// `user.type === 'Bot'` is the one reliable marker of a CI or automation
// comment, and those are walls of text nobody asked the fixer to act on. They
// travel flagged rather than dropped: a bot that names a concrete defect is
// still naming a concrete defect.
function issueComments(project, slug, number, send = github.request) {
  const { items, error, truncated } = restList(
    project,
    (page) => `/repos/${slug.owner}/${slug.repo}/issues/${number}/comments?per_page=${restPerPage}&page=${page}`,
    send,
    (node) => (String(node.body || '').trim() ? {
      id: node.id,
      author: (node.user && node.user.login) || null,
      isBot: Boolean(node.user && node.user.type === 'Bot'),
      body: node.body,
      createdAt: node.created_at || null,
      url: node.html_url || null,
    } : null),
  );
  return { comments: items, error, truncated };
}

// The summary a reviewer writes above their inline comments. Not a thread
// either, so it carries no resolved state. A review with an empty body is the
// bare Approve/Request-changes click and holds nothing to fix; a PENDING one is
// a draft its author has not submitted, and reading it would act on words the
// reviewer has not said out loud yet.
function reviewBodies(project, slug, number, send = github.request) {
  const { items, error, truncated } = restList(
    project,
    (page) => `/repos/${slug.owner}/${slug.repo}/pulls/${number}/reviews?per_page=${restPerPage}&page=${page}`,
    send,
    (node) => (String(node.body || '').trim() && node.state !== 'PENDING' ? {
      id: node.id,
      author: (node.user && node.user.login) || null,
      isBot: Boolean(node.user && node.user.type === 'Bot'),
      state: node.state || null,
      body: node.body,
      createdAt: node.submitted_at || null,
      url: node.html_url || null,
    } : null),
  );
  return { reviews: items, error, truncated };
}

module.exports = {
  graphql, reviewThreads, restOfThread, resolveThread, issueComments, reviewBodies,
  normalizeThread, normalizeComment, stripAnchor,
  threadsQuery, threadCommentsQuery, resolveMutation,
};
