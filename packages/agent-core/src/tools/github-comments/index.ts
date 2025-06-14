import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { Octokit } from '@octokit/rest';
import { authorizeGitHubCli } from '../command-execution/github';

const getPRCommentsSchema = z.object({
  owner: z.string().describe('GitHub repository owner'),
  repo: z.string().describe('GitHub repository name'),
  pullRequestId: z.number().describe('The sequential number of the pull request issued from GitHub'),
});

const replyPRCommentSchema = z.object({
  owner: z.string().describe('GitHub repository owner'),
  repo: z.string().describe('GitHub repository name'),
  pullRequestId: z.number().describe('The sequential number of the pull request issued from GitHub'),
  commentId: z.number().describe('ID of the comment to reply to'),
  body: z.string().describe('The text of the reply comment'),
});

const addIssueCommentSchema = z.object({
  owner: z.string().describe('GitHub repository owner'),
  repo: z.string().describe('GitHub repository name'),
  issueNumber: z.number().describe('The sequential number of the issue issued from GitHub'),
  body: z.string().describe('The text of the comment'),
});

// Utility function to initialize Octokit client
const getOctokitClient = async () => {
  const token = await authorizeGitHubCli();
  return new Octokit({
    auth: token,
  });
};

// Type for review comment with replies
type ReviewCommentWithReplies = Awaited<ReturnType<Octokit['pulls']['listReviewComments']>>['data'][0] & {
  replies: ReviewCommentWithReplies[];
};

// Utility function to format comments in threaded chronological order
const formatCommentsAsThreads = (
  comments: Awaited<ReturnType<Octokit['pulls']['listReviewComments']>>['data']
): string => {
  // Create a map of comment ID to comment for easy lookup
  const commentMap = new Map<number, ReviewCommentWithReplies>();
  const rootComments: ReviewCommentWithReplies[] = [];

  // First pass: organize comments by their relationship
  comments.forEach((comment) => {
    const commentWithReplies: ReviewCommentWithReplies = {
      ...comment,
      replies: [],
    };
    commentMap.set(comment.id, commentWithReplies);

    // If this comment has no in_reply_to_id, it's a root comment
    if (!comment.in_reply_to_id) {
      rootComments.push(commentWithReplies);
    }
  });

  // Second pass: build the thread structure
  comments.forEach((comment) => {
    if (comment.in_reply_to_id) {
      const parentComment = commentMap.get(comment.in_reply_to_id);
      if (parentComment) {
        const commentWithReplies = commentMap.get(comment.id)!;
        parentComment.replies.push(commentWithReplies);
      }
    }
  });

  // Sort root comments by creation time
  rootComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // Format each thread
  const formatThread = (comment: ReviewCommentWithReplies, depth: number = 0): string => {
    const indent = '  '.repeat(depth);
    const timestamp = new Date(comment.created_at).toLocaleString();
    let result = [];
    if (depth == 0) {
      const path = `File: ${comment.path}`;
      if (comment.line ?? comment.original_line) {
        result.push(`${path}:${comment.line ?? comment.original_line}`);
      }
      result.push(comment.diff_hunk);
      result.push('');
    }
    result.push(`${indent}@${comment.user?.login || 'Unknown'} ${timestamp}) (commentId: ${comment.id})`);

    result.push(`${indent}   ${comment.body.replace(/\n/g, `${indent}   `)}`);
    result.push('');

    // Sort and format replies chronologically
    const sortedReplies = comment.replies || [];
    sortedReplies.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    sortedReplies.forEach((reply) => {
      result.push(formatThread(reply, depth + 1));
    });

    return result.join('\n');
  };

  const formattedText = rootComments.map((rootComment) => formatThread(rootComment));

  return formattedText.join('\n---\n');
};

const getPRCommentsHandler = async (input: z.infer<typeof getPRCommentsSchema>) => {
  const { owner, repo, pullRequestId } = input;

  const octokit = await getOctokitClient();

  // Get PR review comments using Octokit
  const { data } = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number: pullRequestId,
  });
  console.log(data);

  if (data.length === 0) {
    return 'No review comments found for this PR.';
  }

  // Format the comments as threaded chronological text
  return formatCommentsAsThreads(data);
};

const replyPRCommentHandler = async (input: z.infer<typeof replyPRCommentSchema>) => {
  const { owner, repo, pullRequestId, commentId, body } = input;

  const octokit = await getOctokitClient();

  // Use Octokit to reply to a comment
  await octokit.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: pullRequestId,
    comment_id: commentId,
    body,
  });

  return `Successfully replied to comment ${commentId}`;
};

const addIssueCommentHandler = async (input: z.infer<typeof addIssueCommentSchema>) => {
  const { owner, repo, issueNumber, body } = input;

  const octokit = await getOctokitClient();

  // Use Octokit to add a comment to an issue
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });

  return `Successfully added comment to issue #${issueNumber}`;
};

// Tool definitions
export const getPRCommentsTool: ToolDefinition<z.infer<typeof getPRCommentsSchema>> = {
  name: 'getPRComments',
  handler: getPRCommentsHandler,
  schema: getPRCommentsSchema,
  toolSpec: async () => ({
    name: 'getPRComments',
    description: 'Get review comments for a specific GitHub PR.',
    inputSchema: {
      json: zodToJsonSchemaBody(getPRCommentsSchema),
    },
  }),
};

export const replyPRCommentTool: ToolDefinition<z.infer<typeof replyPRCommentSchema>> = {
  name: 'replyPRComment',
  handler: replyPRCommentHandler,
  schema: replyPRCommentSchema,
  toolSpec: async () => ({
    name: 'replyPRComment',
    description: 'Reply to a specific comment in a GitHub pull request.',
    inputSchema: {
      json: zodToJsonSchemaBody(replyPRCommentSchema),
    },
  }),
};

export const addIssueCommentTool: ToolDefinition<z.infer<typeof addIssueCommentSchema>> = {
  name: 'addIssueComment',
  handler: addIssueCommentHandler,
  schema: addIssueCommentSchema,
  toolSpec: async () => ({
    name: 'addIssueComment',
    description: 'Add a comment to a specific GitHub issue.',
    inputSchema: {
      json: zodToJsonSchemaBody(addIssueCommentSchema),
    },
  }),
};

// Test script code - only runs when file is executed directly
if (false) {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  const printUsage = () => {
    console.log('Usage:');
    console.log('  npx tsx src/tools/github-comments/index.ts get <owner> <repo> <pullRequestId>');
    console.log('  npx tsx src/tools/github-comments/index.ts reply <owner> <repo> <pullRequestId> <commentId> <body>');
    console.log('  npx tsx src/tools/github-comments/index.ts issue-comment <owner> <repo> <issueNumber> <body>');
    console.log('\nExamples:');
    console.log('  npx tsx src/tools/github-comments/index.ts get aws-samples remote-swe-agents 32');
    console.log(
      '  npx tsx src/tools/github-comments/index.ts reply aws-samples remote-swe-agents 32 1234567890 "Thanks for the feedback!"'
    );
    console.log(
      '  npx tsx src/tools/github-comments/index.ts issue-comment aws-samples remote-swe-agents 45 "This issue is being addressed in PR #32"'
    );
  };

  const runTest = async () => {
    try {
      switch (command) {
        case 'get':
          if (args.length < 4) {
            console.error('Error: Not enough arguments for get command');
            printUsage();
            process.exit(1);
          }

          const [owner, repo, pullRequestId] = args.slice(1);
          console.log(`Getting comments for PR #${pullRequestId} in ${owner}/${repo}...`);

          const getResult = await getPRCommentsHandler({ owner, repo, pullRequestId: parseInt(pullRequestId) });
          console.log('Result:');
          console.log(getResult);
          break;

        case 'reply':
          if (args.length < 6) {
            console.error('Error: Not enough arguments for reply command');
            printUsage();
            process.exit(1);
          }

          const [replyOwner, replyRepo, replyPullRequestId, commentId, ...bodyParts] = args.slice(1);
          const body = bodyParts.join(' ');

          console.log(`Replying to comment ${commentId} in PR #${replyPullRequestId} of ${replyOwner}/${replyRepo}...`);
          console.log(`Message: "${body}"`);

          const replyResult = await replyPRCommentHandler({
            owner: replyOwner,
            repo: replyRepo,
            pullRequestId: parseInt(replyPullRequestId),
            commentId: parseInt(commentId),
            body,
          });

          console.log('Result:');
          console.log(replyResult);
          break;

        case 'issue-comment':
          if (args.length < 5) {
            console.error('Error: Not enough arguments for issue-comment command');
            printUsage();
            process.exit(1);
          }

          const [issueOwner, issueRepo, issueNumber, ...issueBodyParts] = args.slice(1);
          const issueBody = issueBodyParts.join(' ');

          console.log(`Adding comment to issue #${issueNumber} in ${issueOwner}/${issueRepo}...`);
          console.log(`Message: "${issueBody}"`);

          const issueCommentResult = await addIssueCommentHandler({
            owner: issueOwner,
            repo: issueRepo,
            issueNumber: parseInt(issueNumber),
            body: issueBody,
          });

          console.log('Result:');
          console.log(issueCommentResult);
          break;

        default:
          console.error('Error: Unknown command. Use "get", "reply", or "issue-comment"');
          printUsage();
          process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  };

  // Run the test
  runTest();
}
