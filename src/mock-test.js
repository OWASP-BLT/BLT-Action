const nock = require('nock');
const assert = require('assert');
const axios = require('axios');

async function assignUserToIssue(owner, repo, issueNumber, username) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/assignees`;
  const response = await axios.post(url, { assignees: [username] });
  return response.data;
}

async function notifyTeamMembers(owner, repo, issueNumber, message, teamMembers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  for (const member of teamMembers) {
    const response = await axios.post(url, { body: `@${member} ${message}` });
    if (response.status !== 201) {
      throw new Error(`Failed to notify ${member}`);
    }
  }
}

describe('GitHub API Mock Test', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  it('should assign a user to an issue with a PR', async () => {
    const owner = 'testowner';
    const repo = 'testrepo';
    const issueNumber = 1;
    const username = 'testuser';

    const scope = nock('https://api.github.com')
      .post(`/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, { assignees: [username] })
      .reply(201, { status: 'success' });

    const result = await assignUserToIssue(owner, repo, issueNumber, username);
    assert.strictEqual(result.status, 'success');

    scope.done();
  });

  it('should notify team members of a new issue', async () => {
    const owner = 'testowner';
    const repo = 'testrepo';
    const issueNumber = 1;
    const message = 'New issue: Test issue';
    const teamMembers = ['team_member1', 'team_member2'];

    const scope = nock('https://api.github.com')
      .post(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body: `@team_member1 ${message}` })
      .reply(201, { status: 'success' })
      .post(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body: `@team_member2 ${message}` })
      .reply(201, { status: 'success' });

    await notifyTeamMembers(owner, repo, issueNumber, message, teamMembers);

    scope.done();
  });
});
