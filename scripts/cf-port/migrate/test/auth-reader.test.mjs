import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAuthReader, pickAuthUserFields, PROJECT_ID } from '../export.mjs';

/** A stand-in for google-auth-library's GoogleAuth: records every request and
 * answers from a list of pages. No network. */
function fakeGoogleAuth(pages) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async getClient() {
      return {
        async request(options) {
          requests.push(options);
          const data = pages[index] ?? {};
          index += 1;
          return { data };
        },
      };
    },
  };
}

test('the Auth reader asks the pinned project with a GET and the quota-project header', async () => {
  const google = fakeGoogleAuth([{ users: [{ localId: 'u1', email: 'one@example.com' }] }]);
  await createAuthReader(google).listUsers(1000, undefined);

  assert.equal(google.requests.length, 1);
  const [request] = google.requests;
  assert.equal(request.method, 'GET');
  assert.equal(request.headers['x-goog-user-project'], PROJECT_ID);
  const url = new URL(request.url);
  assert.equal(url.hostname, 'identitytoolkit.googleapis.com');
  assert.equal(url.pathname, `/v1/projects/${PROJECT_ID}/accounts:batchGet`);
  assert.equal(url.searchParams.get('maxResults'), '1000');
  assert.equal(url.searchParams.get('nextPageToken'), null);
});

test('password material returned by the API never reaches the output', async () => {
  const google = fakeGoogleAuth([
    {
      users: [
        {
          createdAt: '1758960000000',
          disabled: false,
          displayName: 'Test Admin',
          email: 'admin@example.com',
          emailVerified: true,
          lastLoginAt: '1758963600000',
          localId: 'u1',
          passwordHash: 'aGFzaA==',
          passwordUpdatedAt: 1758960000000,
          phoneNumber: '+46700000000',
          photoUrl: 'https://example.com/p.png',
          providerUserInfo: [{ email: 'admin@example.com', providerId: 'password', rawId: 'admin@example.com' }],
          salt: 'c2FsdA==',
          validSince: '1758960000',
        },
      ],
    },
  ]);
  const page = await createAuthReader(google).listUsers(1000, undefined);
  const written = JSON.stringify(page.users.map(pickAuthUserFields));

  for (const forbidden of ['aGFzaA==', 'c2FsdA==', 'passwordHash', 'salt', 'validSince', '+46700000000', 'photo', 'rawId']) {
    assert.equal(written.includes(forbidden), false, `${forbidden} leaked into the output`);
  }
  assert.deepEqual(page.users.map(pickAuthUserFields), [
    {
      disabled: false,
      displayName: 'Test Admin',
      email: 'admin@example.com',
      emailVerified: true,
      metadata: { creationTime: '2025-09-27T08:00:00.000Z', lastSignInTime: '2025-09-27T09:00:00.000Z' },
      providerData: [{ providerId: 'password' }],
      uid: 'u1',
    },
  ]);
});

test('pagination: the next token is passed on, and an empty page ends the listing', async () => {
  const google = fakeGoogleAuth([
    { nextPageToken: 'page-2', users: [{ localId: 'u1' }] },
    { nextPageToken: 'page-3', users: [] },
  ]);
  const reader = createAuthReader(google);

  const first = await reader.listUsers(1, undefined);
  assert.equal(first.pageToken, 'page-2');
  const second = await reader.listUsers(1, first.pageToken);
  assert.equal(new URL(google.requests[1].url).searchParams.get('nextPageToken'), 'page-2');
  assert.deepEqual(second.users, []);
  assert.equal(second.pageToken, undefined);
});

test('a user without sign-in times gets nulls, not invalid dates', async () => {
  const google = fakeGoogleAuth([{ users: [{ localId: 'u1' }] }]);
  const page = await createAuthReader(google).listUsers(1000, undefined);
  assert.deepEqual(page.users[0].metadata, { creationTime: null, lastSignInTime: null });
});
