/**
 * Offline eval data for auto-recall matching. Each positive is a paraphrase a developer might
 * type (few shared words) with the note it should surface; negatives are unrelated requests that
 * must stay silent. Used by the eval test to keep recall high and noise low as matching evolves.
 */
export const NOTES: string[] = [
  'Login sessions are kept in Redis with a 30 minute sliding expiry',
  'Database migrations run automatically on deploy through the release script',
  'Stripe webhooks must be idempotent, dedupe on the event id before saving',
  'The product search endpoint is slow because of a missing index on category_id',
  'Environment variables are loaded from .env.local and never committed',
  'Integration tests need docker compose up first, unit tests run without it',
  'Structured logs go through pino, never console.log in server code',
  'Background jobs use BullMQ with three retries and exponential backoff',
  'Production deploys go through GitHub Actions on tags, never from a laptop',
  'ESLint runs in CI and the build fails on warnings',
  'REST endpoints are versioned under /v2 and old /v1 routes are frozen',
  'Feature flags live in LaunchDarkly and are cached sixty seconds per process',
  'Passwords are hashed with argon2id, never bcrypt in new code',
  'Transactional email goes through Postmark, marketing through Mailchimp',
  'User avatars are resized to 256px by the thumbnail lambda on upload',
  'Translations live in locales/*.json and missing keys fall back to English',
  'Nightly reports run via the cron scheduler on the analytics cluster',
  'The websocket gateway leaked memory until we removed the listener on disconnect',
  'Squash merge only; commit messages follow conventional commits',
  'Static assets are cached at the CDN for a year and busted by hash in filenames'
];

/** [query, index of the note that should be recalled] */
export const POSITIVES: Array<[string, number]> = [
  ['why does authentication expire so quickly for user sessions', 0],
  ['how do sql schema changes get applied when we ship', 1],
  ['handle duplicate stripe callbacks safely', 2],
  ['search latency got worse, what was the performance problem', 3],
  ['where do configuration settings come from at startup', 4],
  ['how do I run the spec suite locally', 5],
  ['what logger should backend code use for tracing output', 6],
  ['how are worker tasks retried when they fail', 7],
  ['how do we publish a new release to prod', 8],
  ['why did the pipeline fail on lint warnings', 9],
  ['which api version should new routes use', 10],
  ['how do toggles get refreshed at runtime', 11],
  ['which algorithm do we use to hash credentials', 12],
  ['which provider sends our transactional emails', 13],
  ['where do profile pictures get scaled down', 14],
  ['what happens when a language string is not translated', 15],
  ['when do the scheduled jobs for reporting execute', 16],
  ['why was the socket server using too much RAM', 17],
  ['what format should commit messages use', 18],
  ['how do we invalidate the frontend bundle cache when files change', 19]
];

export const NEGATIVES: string[] = [
  'write a python script that renames all files in a folder by date',
  'explain how binary search trees rebalance themselves',
  'what is the difference between let and const in javascript',
  'help me draft a polite reply to a customer about a delayed shipment',
  'how do I center a div with flexbox in css',
  'summarize the plot of the movie inception',
  'what are good names for a puppy',
  'why is my sourdough starter not rising',
  'convert this csv to json with jq',
  'explain big o notation with examples',
  'which git command undoes the last commit',
  'write a unit test for a fibonacci function',
  'how do I reverse a linked list in place',
  'what does the yield keyword do in a generator',
  'please review this regex for matching phone numbers',
  'give me a recipe for vegetarian lasagna tonight'
];

/** Hold-out set: written after tuning, on other topics. Evaluated as-is; never tune against it. */
export const HOLDOUT_NOTES: string[] = [
  'The mobile app talks to the GraphQL gateway, never to the REST services directly',
  'Rate limiting is 100 requests per minute per API key, enforced at the edge',
  'Uploads over 5MB are streamed to S3 with presigned URLs instead of through the API',
  'Search indexing runs in the worker after each product update using Elasticsearch',
  'The monorepo uses pnpm workspaces; run installs from the repository root only',
  'Dates are stored in UTC and converted to the user timezone in the browser',
  'Two factor authentication is mandatory for admin accounts via TOTP apps',
  'Docker images are built with multi-stage builds and pinned base image digests',
  'Sentry captures frontend exceptions; source maps are uploaded during the release',
  'Never edit generated files under src/gen, regenerate them with the codegen script'
];

export const HOLDOUT_POSITIVES: Array<[string, number]> = [
  ['how should the phone client fetch data from the backend', 0],
  ['how many calls per minute can a client make before throttling', 1],
  ['what is the way to send large files to storage', 2],
  ['when does the product search index get refreshed after edits', 3],
  ['where should I run package installs in the workspace', 4],
  ['which timezone do we save timestamps in', 5],
  ['do administrators need mfa to log in', 6],
  ['how are container images built for production', 7],
  ['where do frontend crashes get reported', 8],
  ['can I hand edit the generated code', 9]
];

export const HOLDOUT_NEGATIVES: string[] = [
  'translate this paragraph into french',
  'how do I compute the median of a list in python',
  'what is a monad in haskell',
  'suggest a name for my new startup',
  'how to make cold brew coffee at home',
  'explain the difference between tcp and udp',
  'write a sql query to find duplicate rows',
  'how do I rebase onto main and resolve conflicts',
  'what is the capital of australia',
  'format this json nicely',
  'explain what docker is used for',
  'why is my react component re-rendering'
];
