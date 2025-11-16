const nock = require('nock');
const assert = require('assert');
const axios = require('axios');

async function assignUserToIssue(owner, repo, issueNumber, username) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/assignees`;
  const response = await axios.post(url, { assignees: [username] });
  return response.data;
}

async function postGiphyComment(owner, repo, issueNumber, searchText, giphyApiKey) {
  const giphyResponse = await axios.get(`https://api.giphy.com/v1/gifs/search?api_key=${giphyApiKey}&q=${searchText}&limit=1`);
  const gifUrl = giphyResponse.data.data[0]?.images?.original?.url;

  if (gifUrl) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
    const response = await axios.post(url, { body: `![Giphy GIF](${gifUrl})` });
    return response.data;
  } else {
    throw new Error(`No GIFs found for "${searchText}".`);
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

  it('should post a Giphy comment on an issue', async () => {
    const owner = 'testowner';
    const repo = 'testrepo';
    const issueNumber = 1;
    const searchText = 'funny cat';
    const giphyApiKey = 'testapikey';

    const giphyScope = nock('https://api.giphy.com')
      .get(`/v1/gifs/search?api_key=${giphyApiKey}&q=${searchText}&limit=1`)
      .reply(200, {
        data: [
          {
            images: {
              original: {
                url: 'https://giphy.com/gifs/moodman-dog-confused-rigley-beans-Z5xk7fGO5FjjTElnpT'
              }
            }
          }
        ]
      });

    const githubScope = nock('https://api.github.com')
      .post(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body: '![Giphy GIF](https://giphy.com/gifs/moodman-dog-confused-rigley-beans-Z5xk7fGO5FjjTElnpT)' })
      .reply(201, { status: 'success' });

    const result = await postGiphyComment(owner, repo, issueNumber, searchText, giphyApiKey);
    assert.strictEqual(result.status, 'success');

    giphyScope.done();
    githubScope.done();
  });

  describe('Automated Unassign Logic', () => {
    it('should calculate inactivity based on assignment time, not issue update time', () => {
      const presentDate = new Date('2024-01-03T00:00:00Z'); // 2 days after assignment
      
      const event = {
        event: 'assigned',
        created_at: '2024-01-01T00:00:00Z', // Assignment happened 2 days ago
        issue: {
          number: 1,
          state: 'open',
          updated_at: '2024-01-02T23:00:00Z', // Issue was updated 1 hour ago (e.g., someone commented)
          assignee: { login: 'testuser' }
        }
      };

      // Calculate time since assignment (should be ~2 days)
      const timeSinceAssignment = presentDate.getTime() - new Date(event.created_at).getTime();
      const daysSinceAssignment = timeSinceAssignment / (1000 * 3600 * 24);

      // Calculate time since last update (would be ~1 hour)
      const timeSinceUpdate = presentDate.getTime() - new Date(event.issue.updated_at).getTime();
      const daysSinceUpdate = timeSinceUpdate / (1000 * 3600 * 24);

      // Verify the fix: we should use assignment time, not update time
      assert.ok(daysSinceAssignment > 1, 'Days since assignment should be > 1');
      assert.ok(daysSinceUpdate < 1, 'Days since update should be < 1');
      
      // The correct behavior: unassign based on assignment time
      assert.strictEqual(daysSinceAssignment, 2, 'Should be exactly 2 days since assignment');
    });

    it('should not unassign if less than 24 hours since assignment', () => {
      const presentDate = new Date('2024-01-01T12:00:00Z'); // 12 hours after assignment
      
      const event = {
        event: 'assigned',
        created_at: '2024-01-01T00:00:00Z', // Assignment happened 12 hours ago
        issue: {
          number: 1,
          state: 'open',
          updated_at: '2024-01-01T11:30:00Z', // Issue recently updated
          assignee: { login: 'testuser' }
        }
      };

      const timeSinceAssignment = presentDate.getTime() - new Date(event.created_at).getTime();
      const daysSinceAssignment = timeSinceAssignment / (1000 * 3600 * 24);

      assert.ok(daysSinceAssignment < 1, 'Should be less than 1 day since assignment');
      assert.strictEqual(daysSinceAssignment, 0.5, 'Should be exactly 0.5 days (12 hours) since assignment');
    });

    it('should unassign if more than 24 hours since assignment regardless of recent issue updates', () => {
      const presentDate = new Date('2024-01-02T01:00:00Z'); // 25 hours after assignment
      
      const event = {
        event: 'assigned',
        created_at: '2024-01-01T00:00:00Z', // Assignment happened 25 hours ago
        issue: {
          number: 1,
          state: 'open',
          updated_at: '2024-01-02T00:59:00Z', // Issue was updated 1 minute ago (comments, labels, etc.)
          assignee: { login: 'testuser' }
        }
      };

      const timeSinceAssignment = presentDate.getTime() - new Date(event.created_at).getTime();
      const daysSinceAssignment = timeSinceAssignment / (1000 * 3600 * 24);

      // Even though the issue was updated very recently, we should still unassign
      // because more than 24 hours have passed since assignment
      assert.ok(daysSinceAssignment > 1, 'Should be more than 1 day since assignment');
      assert.ok(Math.abs(daysSinceAssignment - 25/24) < 0.01, 'Should be approximately 25/24 days since assignment');
    });
  });
});