'use strict';

// Method 3 — differential test (the authoritative "bake both cakes" check).
//
// Drives the SAME register/follow/compose requests against TWO live, full
// stacks (the original C++ benchmark and this JS port), then reads the
// timelines from each and asserts they are identical after normalizing the
// handful of fields that are inherently per-stack.
//
// The C++ stack is the oracle: we are not comparing to a hard-coded constant,
// we are comparing the JS port's real end-to-end output (real Thrift wire, real
// Mongo/Redis/memcached, real nginx) to the C++ port's real output.
//
// This needs both stacks running. It auto-skips when the URLs are not set so it
// never breaks `npm test`. Run it explicitly with:
//
//   DIFF_CPP_URL=http://localhost:8080 \
//   DIFF_JS_URL=http://localhost:18080 \
//   node --test test/differential.test.js
//
// Bring the stacks up first on different host ports. Both compose files
// publish nginx on 8080 by default, so remap one. Easiest is a throwaway
// override for the JS stack:
//
//   (cd ../socialNetwork && docker compose up -d)          # C++ -> :8080
//   # JS stack on :18080 via an override:
//   cat > /tmp/diff.override.yml <<'YAML'
//   services:
//     nginx-thrift:
//       ports: ["18080:8080"]
//   YAML
//   docker compose -f docker-compose.yml -f /tmp/diff.override.yml up -d
//
// (Or just run the two stacks on two separate machines, which is the typical
// benchmarking setup anyway.)
//
// Because register uses RegisterUserWithId, user_ids are deterministic and
// identical across both stacks, which is what makes this comparison clean.

const assert = require('node:assert/strict');
const test = require('node:test');

const CPP_URL = process.env.DIFF_CPP_URL;
const JS_URL = process.env.DIFF_JS_URL;

// Fields that are legitimately allowed to differ between stacks and must be
// normalized away before comparing:
//   post_id   - generated from machine-id + clock + counter, per stack
//   timestamp - wall clock at compose time, per stack
//   req_id    - derived from the nginx request id, per request
//   shortened_url suffix - 10 random chars chosen by UrlShortenService
const SHORT_URL = /http:\/\/short-url\/[A-Za-z0-9]+/g;

function normalizePost(post) {
  return {
    creator: { user_id: String(post.creator.user_id), username: post.creator.username },
    // text has shortened URLs substituted in; mask the random suffix.
    text: post.text.replace(SHORT_URL, 'http://short-url/__'),
    post_type: post.post_type,
    user_mentions: (post.user_mentions || [])
      .map((m) => ({ user_id: String(m.user_id), username: m.username }))
      .sort((a, b) => a.user_id.localeCompare(b.user_id)),
    media: (post.media || []).map((m) => ({ media_id: String(m.media_id), media_type: m.media_type })),
    urls: (post.urls || []).map((u) => ({
      expanded_url: u.expanded_url,
      shortened_url: u.shortened_url.replace(SHORT_URL, 'http://short-url/__')
    }))
    // post_id / timestamp / req_id deliberately dropped.
  };
}

// An empty timeline is serialized by Lua cjson as `{}` (an empty object), not
// `[]`, on both stacks. Coerce any non-array response to an empty list.
const asArray = (value) => (Array.isArray(value) ? value : []);
const normalizeTimeline = (posts) => asArray(posts).map(normalizePost);

async function form(base, path, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  return { status: res.status, text: await res.text() };
}

async function getJson(base, path) {
  const res = await fetch(base + path);
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`GET ${path} on ${base} -> ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

// Apply the same mutating request to BOTH stacks so they stay in lockstep.
async function onBoth(path, fields) {
  const [cpp, js] = await Promise.all([
    form(CPP_URL, path, fields),
    form(JS_URL, path, fields)
  ]);
  assert.equal(js.status, cpp.status, `${path} status diverged between C++ and JS`);
  assert.equal(js.status, 200, `${path} failed on both stacks: cpp=${cpp.text} js=${js.text}`);
  return { cpp, js };
}

test('differential: identical drive -> identical timelines on C++ and JS stacks', { skip: (!CPP_URL || !JS_URL) && 'set DIFF_CPP_URL and DIFF_JS_URL to run' }, async () => {
  // Unique id space per run so re-runs don't collide with prior registrations.
  const base = (Date.now() % 1_000_000) * 100;
  const uname = (n) => `diff_${base + n}`;
  const uid = (n) => String(base + n);

  // --- register the same 4 users on both stacks (deterministic user_ids) ----
  for (let n = 1; n <= 4; n += 1) {
    await onBoth('/wrk2-api/user/register', {
      first_name: `first_${n}`,
      last_name: `last_${n}`,
      username: uname(n),
      password: `pw_${n}`,
      user_id: uid(n)
    });
  }

  // --- same follow graph: 2,3,4 all follow 1 -------------------------------
  for (const follower of [2, 3, 4]) {
    await onBoth('/wrk2-api/user/follow', {
      user_name: uname(follower),
      followee_name: uname(1)
    });
  }

  // --- user 1 composes fixed posts (mention + url + media) -------------------
  // Fully deterministic content so only per-stack fields can differ.
  const firstText = `first hello @${uname(2)} see http://example.com/page1`;
  await onBoth('/wrk2-api/post/compose', {
    username: uname(1),
    user_id: uid(1),
    text: firstText,
    media_ids: '["100000000000000001"]',
    media_types: '["png"]',
    post_type: '0'
  });

  // Keep timestamp scores distinct so timeline ordering is deterministic.
  await new Promise((r) => setTimeout(r, 20));

  // User 4 is both a follower and a mention target. The home timeline should
  // still contain one copy of this post, matching the C++ set-dedup behavior.
  const secondText = `second hello @${uname(4)} see http://example.com/page2`;
  await onBoth('/wrk2-api/post/compose', {
    username: uname(1),
    user_id: uid(1),
    text: secondText,
    media_ids: '["100000000000000002"]',
    media_types: '["jpg"]',
    post_type: '0'
  });

  // Give async/home-timeline fan-out a moment to settle on both stacks.
  await new Promise((r) => setTimeout(r, 1500));

  // --- author's user timeline must match -----------------------------------
  const utPath = `/wrk2-api/user-timeline/read?user_id=${uid(1)}&start=0&stop=10`;
  const [cppUt, jsUt] = await Promise.all([getJson(CPP_URL, utPath), getJson(JS_URL, utPath)]);
  const normCppUt = normalizeTimeline(cppUt);
  const normJsUt = normalizeTimeline(jsUt);
  assert.deepEqual(normJsUt, normCppUt,
    'user-timeline content diverged between C++ and JS');
  assert.deepEqual(normJsUt.map((post) => post.text), [
    `second hello @${uname(4)} see http://short-url/__`,
    `first hello @${uname(2)} see http://short-url/__`
  ], 'user-timeline order diverged from newest-first expectation');

  // --- a follower's home timeline must match (proves fan-out parity) --------
  const htPath = `/wrk2-api/home-timeline/read?user_id=${uid(3)}&start=0&stop=10`;
  const [cppHt, jsHt] = await Promise.all([getJson(CPP_URL, htPath), getJson(JS_URL, htPath)]);
  const normCppHt = normalizeTimeline(cppHt);
  const normJsHt = normalizeTimeline(jsHt);
  assert.deepEqual(normJsHt, normCppHt,
    'home-timeline content diverged between C++ and JS');
  assert.deepEqual(normJsHt.map((post) => post.text), normJsUt.map((post) => post.text),
    'home-timeline order diverged from user timeline');

  // --- a mentioned follower must not receive duplicate fan-out entries -------
  const mentionedHtPath = `/wrk2-api/home-timeline/read?user_id=${uid(4)}&start=0&stop=10`;
  const [cppMentionedHt, jsMentionedHt] = await Promise.all([
    getJson(CPP_URL, mentionedHtPath),
    getJson(JS_URL, mentionedHtPath)
  ]);
  const normCppMentionedHt = normalizeTimeline(cppMentionedHt);
  const normJsMentionedHt = normalizeTimeline(jsMentionedHt);
  assert.deepEqual(normJsMentionedHt, normCppMentionedHt,
    'mentioned follower home-timeline content diverged between C++ and JS');

  // Sanity: the post actually landed (not two empty timelines comparing equal).
  assert.equal(jsUt.length, 2, 'expected exactly two posts in user timeline');
  assert.equal(jsHt.length, 2, 'expected both followed posts to fan out to home timeline');
  assert.equal(jsMentionedHt.length, 2, 'expected follower/mention dedup to keep two home-timeline posts');
});
