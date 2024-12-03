const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');

const run = async () => {
    console.log("starting");
    const gitHubToken = core.getInput('repo-token', { required: true });
    const githubOwner = github.context.repo.owner;
    const githubRepo = github.context.repo.repo;
    const repository = `${githubOwner}/${githubRepo}`;
    const octokit = github.getOctokit(gitHubToken);
    console.log(repository);

    const { eventName, payload } = github.context;
    const { issue, comment, pull_request } = payload;
    const [owner, repo] = repository.split('/');
    let proceedWithIssueProcessing = false; // Initialize the flag
    console.log(eventName);

    if (eventName === 'pull_request' && pull_request) {
        try {
            // This part is to ensure that whenever a PR is raised, the PR body contains an issue reference (e.g., "fixes #123")
            const prBody = pull_request.body || '';

            // Regular expression to match issue references like 'fixes #123' or 'closes #123', similar to the one we check later on for closure
            const issueReferenceRegex = /\b(fixes|closes|resolves|related)\s+#\d+\b/i;

            if (!issueReferenceRegex.test(prBody)) {
                console.log('No issue reference found in PR body.');
                
                // Optionally, post a comment on the PR to ask for the issue reference
                await octokit.rest.issues.createComment({
                    owner: githubOwner,
                    repo: githubRepo,
                    issue_number: pull_request.number,
                    body: 'Please mention an issue number in the format "fixes #<issue_number>" or "closes #<issue_number>" in your PR description.'
                });

                // Fail the action here and tell the author to add issue reference in body
                core.setFailed('Pull request description must mention an issue number (e.g., "fixes #123").');
            } else {
                console.log('PR description contains a valid issue reference.');
            }
            // Check if PR is merged
            if (pull_request.merged) {

                const linkedIssues = await findLinkedIssues(octokit, owner, repo, pull_request.number);
                
                for (const issueNumber of linkedIssues) {
                    // Fetch issue details of all linked issues for analysis
                    const issueDetails = await octokit.rest.issues.get({
                        owner,
                        repo,
                        issue_number: issueNumber
                    });

                    // Here we check for other scenarios (provides flexibility to not auto-close issues)
                    const hasOpenComments = await checkPendingWorkComments(octokit, owner, repo, issueNumber);
                    const hasComplexLabels = issueDetails.data.labels.some(
                        label => ['epic', 'requires-investigation', 'blocked'].includes(label.name)
                    );

                    if (!hasOpenComments && !hasComplexLabels) {
                        // Close the issue if no pending work (pending work determined by the comments and labels)
                        await octokit.rest.issues.update({
                            owner,
                            repo,
                            issue_number: issueNumber,
                            state: 'closed',
                            labels: ['resolved-by-pr']
                        });
                    } else {
                        // Add partial resolution label
                        await octokit.rest.issues.addLabels({
                            owner,
                            repo,
                            issue_number: issueNumber,
                            labels: ['partially-resolved']
                        });
                    }
                }
            }
        } catch (error) {
            console.error('PR Processing Error:', error);
        }
    }

    if (eventName === 'issue_comment' && issue && comment) {
        console.log('processing issue comment');
        const commentBody = comment.body.toLowerCase(); // Convert to lower case for case-insensitive comparison
        const assignKeywords = ['/assign', 'assign to me', 'assign this to me', 'please assign me this', 'i can try fixing this', 'i am interested in doing this', 'i am interested in contributing'];
        const unassignKeywords = ['/unassign'];

        const shouldAssign = assignKeywords.some(keyword => commentBody.includes(keyword));
        const shouldUnassign = unassignKeywords.some(keyword => commentBody.startsWith(keyword));

        if (shouldAssign) {
            proceedWithIssueProcessing = true; // Set flag to true
        } else if (shouldUnassign) {
            console.log(`Unassigning issue #${issue.number} from ${comment.user.login}`);
            await octokit.issues.removeAssignees({
                owner,
                repo,
                issue_number: issue.number,
                assignees: [comment.user.login]
            });
        }
    }

    if (issue && proceedWithIssueProcessing) {
        console.log('processing issue');
        const assigneeLogin = comment.user.login;
        const assignees = assigneeLogin.split(',').map(assigneeName => assigneeName.trim());
        var addAssignee = true;
        var issuesWithoutPR = [];

        // Retrieve all open issues assigned to the user
        const assignedIssues = await octokit.paginate(octokit.issues.listForRepo, {
            owner,
            repo,
            state: 'open',
            assignee: assigneeLogin
        });
        for (const assignedIssue of assignedIssues) {
            // Skip if it's the same issue
            if (assignedIssue.number === issue.number) {
                continue;
            }

            // Construct a search query to find pull requests that mention the assigned issue
            const query = `type:pr state:open repo:${owner}/${repo} ${assignedIssue.number} in:body`;
            const pullRequests = await octokit.search.issuesAndPullRequests({
                q: query
            });

            // If there are no pull requests mentioning the issue number in their body, add it to the list
            if (pullRequests.data.total_count === 0) {
                console.log(`Issue #${assignedIssue.number} does not have an open pull request`);
                issuesWithoutPR.push(assignedIssue.number);
                break;
            }
        }
        if (issuesWithoutPR.length > 0) {
            addAssignee = false;
            const issueList = issuesWithoutPR.join(', #');
            await octokit.issues.createComment({
                owner,
                repo,
                issue_number: issue.number,
                body: `You cannot be assigned to this issue because you are already assigned to the following issues without an open pull request: #${issueList}. Please submit a pull request for these issues before getting assigned to a new one.`
            });
        } else if (addAssignee) {
            await octokit.issues.addAssignees({
                owner,
                repo,
                issue_number: issue.number,
                assignees
            });

            // Add the message to the issue
            await octokit.issues.createComment({
                owner,
                repo,
                issue_number: issue.number,
                body: `Hello @${assigneeLogin}! You've been assigned to [${repository}](https://github.com/${repository}/issues/${issue.number}). You have 24 hours to complete a pull request. To place a bid and potentially earn some BCH, type /bid [amount in BCH] [BCH address].`
            });
        }
    } else {
        console.log('Removing assignees greater than 24 hours and posting a note');
        var last_event = new Object()
        last_event.issue = new Object()
        last_event.issue.number = "";
        var present_date = new Date();

        await octokit.paginate(octokit.issues.listEventsForRepo, {
            owner,
            repo,
            per_page: 100,
        }, response => response.data.filter(r => r.event == "assigned")
        ).then(async (data) => {
            for (const event of data) {

                if (event.issue.assignee && event.issue.state == "open") {

                    var Difference_In_Time = present_date.getTime() - Date.parse(event.issue.updated_at);

                    if (last_event.issue.number != event.issue.number) {

                        console.log(
                            event.issue.updated_at + " " +
                            event.issue.number + " " +
                            event.assignee.login + " " +
                            event.issue.assignee.login + " " +
                            event.issue.state + " " +
                            (Difference_In_Time / (1000 * 3600 * 24)).toString() + " days",
                        );

                        if ((Difference_In_Time / (1000 * 3600 * 24)) > 1) {
                            // Check if the issue has any labels
                            const issueDetails = await octokit.issues.get({
                                owner,
                                repo,
                                issue_number: event.issue.number
                            });
                            

                            if (issueDetails.data.labels.length === 0) {
                                console.log('unassigning ' + event.issue.assignee.login + " from " + event.issue.number);
                                const assignees = event.issue.assignee.login.split(',').map((assigneeName) => assigneeName.trim());
                                var issue_number = event.issue.number;

                                await octokit.issues.removeAssignees({
                                    owner,
                                    repo,
                                    issue_number,
                                    assignees,
                                });

                                // Add a comment about unassignment
                                await octokit.issues.createComment({
                                    owner,
                                    repo,
                                    issue_number: event.issue.number,
                                    body: `⏰ This issue has been automatically unassigned due to 24 hours of inactivity. 
                                    The issue is now available for anyone to work on again.`
                                });
                            } else {
                                console.log(`Issue #${event.issue.number} has labels, skipping unassign.`);
                            }
                        }
                    }
                }
                last_event = event;
            }
        });
    }
}

// Function to handle symbolic links during the unwrapping process
const handleSymbolicLinks = (srcPath, destPath) => {
    if (fs.lstatSync(srcPath).isSymbolicLink()) {
        const realPath = fs.realpathSync(srcPath);
        if (fs.existsSync(realPath)) {
            fs.symlinkSync(realPath, destPath);
        } else {
            console.log(`Skipping broken symbolic link: ${srcPath}`);
        }
    } else {
        fs.copyFileSync(srcPath, destPath);
    }
};

// Example usage of handleSymbolicLinks function
const unwrap = (srcDir, destDir) => {
    fs.readdirSync(srcDir).forEach(file => {
        const srcPath = path.join(srcDir, file);
        const destPath = path.join(destDir, file);
        handleSymbolicLinks(srcPath, destPath);
    });
};

async function findLinkedIssues(octokit, owner, repo, prNumber) {
    // Fetch PR details to get body
    const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_request_number: prNumber
    });

    // Extract issue numbers from PR body
    const bodyIssues = (pullRequest.body || '').match(/(?:fixes|closes|resolves|related)\s*#(\d+)/gi)
        ?.map(match => parseInt(match.match(/\d+/)[0]))
        || [];

    // Fetch PR comments
    const { data: prComments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber
    });

    // Extract issue numbers from comments
    const commentIssues = prComments
        .filter(comment => 
            comment.body.includes('fixes #') || 
            comment.body.includes('closes #')
        )
        .map(comment => {
            const match = comment.body.match(/(?:fixes|closes|resolves|related)\s*#(\d+)/i);
            return match ? parseInt(match[1]) : null;
        })
        .filter(Boolean);

    // Combine the results. We may get duplicates so use Set to get rid of them
    return [...new Set([...bodyIssues, ...commentIssues])];
}

// Check for pending work in comments
async function checkPendingWorkComments(octokit, owner, repo, issueNumber) {
    const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber
    });

    return comments.some(
        comment => 
            comment.body.includes('#TODO') || 
            comment.body.includes('pending work') || 
            comment.body.includes('partial work') || 
            comment.body.includes('need more investigation')
    );
}

run();
